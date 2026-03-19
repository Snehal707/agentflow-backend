import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { getAddress, type Address } from 'viem';
import { signTypedDataWithCircleWallet } from './circleWallet';

const CIRCLE_BATCHING_NAME = 'GatewayWalletBatched';
const CIRCLE_BATCHING_VERSION = '1';
const CIRCLE_BATCHING_SCHEME = 'exact';

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

type JsonRequestBody = Record<string, unknown> | undefined;

type GatewayBatchingRequirement = PaymentRequirements & {
  extra: Record<string, unknown> & {
    name?: string;
    version?: string;
    verifyingContract?: string;
  };
};

export interface PayProtectedResourceServerResult<T> {
  data: T;
  status: number;
  transaction?: string;
}

export interface PayProtectedResourceServerInput<TBody extends JsonRequestBody> {
  url: string;
  method?: 'GET' | 'POST';
  body?: TBody;
  circleWalletId: string;
  payer: Address;
  chainId: number;
  headers?: Record<string, string>;
}

function createNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;
}

function isGatewayBatchingOption(
  requirements: PaymentRequirements,
  chainId: number,
): requirements is GatewayBatchingRequirement {
  if (!requirements) return false;
  if (requirements.scheme !== CIRCLE_BATCHING_SCHEME) return false;
  if (requirements.network !== `eip155:${chainId}`) return false;
  const extra = (requirements as PaymentRequirements).extra;
  if (!extra || typeof extra !== 'object') return false;
  const typedExtra = extra as GatewayBatchingRequirement['extra'];
  return (
    typedExtra.name === CIRCLE_BATCHING_NAME &&
    typedExtra.version === CIRCLE_BATCHING_VERSION &&
    typeof typedExtra.verifyingContract === 'string'
  );
}

class ServerGatewayBatchScheme {
  readonly scheme = CIRCLE_BATCHING_SCHEME;

  constructor(
    private readonly circleWalletId: string,
    private readonly payer: Address,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<{
    x402Version: number;
    payload: {
      authorization: {
        from: Address;
        to: Address;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
      signature: `0x${string}`;
    };
  }> {
    const requirements = paymentRequirements as GatewayBatchingRequirement;
    const verifyingContract = requirements.extra?.verifyingContract;
    if (!verifyingContract) {
      throw new Error('Gateway batching option missing extra.verifyingContract.');
    }

    if (!requirements.network.startsWith('eip155:')) {
      throw new Error(
        `Unsupported network format "${requirements.network}". Expected eip155:<chainId>.`,
      );
    }

    const chainId = Number(requirements.network.split(':')[1]);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new Error(`Invalid chain id in network "${requirements.network}".`);
    }

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: getAddress(this.payer),
      to: getAddress(requirements.payTo as Address),
      value: requirements.amount,
      validAfter: String(now - 600),
      validBefore: String(now + requirements.maxTimeoutSeconds),
      nonce: createNonce(),
    };

    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        TransferWithAuthorization: transferWithAuthorizationTypes.TransferWithAuthorization,
      },
      domain: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        chainId,
        verifyingContract: getAddress(verifyingContract as Address),
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
        nonce: authorization.nonce,
      },
    };

    // eslint-disable-next-line no-console
    console.log('[x402Server] FULL typedData:', JSON.stringify(typedData, null, 2));

    const signature = (await signTypedDataWithCircleWallet(
      this.circleWalletId,
      typedData,
    )) as `0x${string}`;

    return {
      x402Version,
      payload: {
        authorization,
        signature,
      },
    };
  }
}

async function parseResponseBody<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw) return {} as T;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }
  return raw as T;
}

async function buildX402HttpClient(
  circleWalletId: string,
  payer: Address,
  chainId: number,
): Promise<x402HTTPClient> {
  const client = new x402Client((_version, requirements) => {
    const matching = requirements.find((requirement) =>
      isGatewayBatchingOption(requirement, chainId),
    );
    if (!matching) {
      throw new Error(
        `No GatewayWalletBatched payment option found for eip155:${chainId}.`,
      );
    }
    return matching;
  });

  client.register(
    `eip155:${chainId}`,
    new ServerGatewayBatchScheme(circleWalletId, payer),
  );
  return new x402HTTPClient(client);
}

export async function payProtectedResourceServer<
  TResponse,
  TBody extends JsonRequestBody,
>(input: PayProtectedResourceServerInput<TBody>): Promise<
  PayProtectedResourceServerResult<TResponse>
> {
  const method = input.method ?? 'POST';
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(input.headers || {}),
  };

  const execute = async (headers: Record<string, string>): Promise<Response> =>
    fetch(input.url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(input.body ?? {}) : undefined,
    });

  const initialResponse = await execute(baseHeaders);

  if (initialResponse.status !== 402) {
    const data = await parseResponseBody<TResponse>(initialResponse);
    if (!initialResponse.ok) {
      const details = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(
        `Agent call failed with status ${initialResponse.status}: ${details}`,
      );
    }
    const settleHeader = initialResponse.headers.get('PAYMENT-RESPONSE');
    const settle = settleHeader
      ? decodePaymentResponseHeader(settleHeader)
      : undefined;
    return {
      data,
      status: initialResponse.status,
      transaction: settle?.transaction,
    };
  }

  const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    throw new Error('Missing PAYMENT-REQUIRED header in 402 response.');
  }

  const paymentRequired = decodePaymentRequiredHeader(
    paymentRequiredHeader,
  ) as PaymentRequired;
  const httpClient = await buildX402HttpClient(
    input.circleWalletId,
    input.payer,
    input.chainId,
  );

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidResponse = await execute({
    ...baseHeaders,
    ...paymentHeaders,
  });

  const paidData = await parseResponseBody<TResponse>(paidResponse);
  if (!paidResponse.ok) {
    const details =
      typeof paidData === 'string' ? paidData : JSON.stringify(paidData);
    throw new Error(
      `Payment retry failed with status ${paidResponse.status}: ${details}`,
    );
  }

  const paymentResponseHeader = paidResponse.headers.get('PAYMENT-RESPONSE');
  const settle = paymentResponseHeader
    ? decodePaymentResponseHeader(paymentResponseHeader)
    : undefined;

  return {
    data: paidData,
    status: paidResponse.status,
    transaction: settle?.transaction,
  };
}

