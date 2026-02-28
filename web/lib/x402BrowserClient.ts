import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { getAddress, type Address, type Hex, type WalletClient } from 'viem';

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

export interface PayProtectedResourceResult<T> {
  data: T;
  status: number;
  transaction?: string;
}

export interface PayProtectedResourceInput<TBody extends JsonRequestBody> {
  url: string;
  method?: 'GET' | 'POST';
  body?: TBody;
  walletClient: WalletClient;
  payer: Address;
  chainId: number;
  headers?: Record<string, string>;
  onAwaitSignature?: () => void;
}

function createNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}` as Hex;
}

function isGatewayBatchingOption(
  requirements: PaymentRequirements,
  chainId: number,
): requirements is GatewayBatchingRequirement {
  if (!requirements) return false;
  if (requirements.scheme !== CIRCLE_BATCHING_SCHEME) return false;
  if (requirements.network !== `eip155:${chainId}`) return false;
  const extra = (requirements as PaymentRequirements).extra;
  if (!extra || typeof extra !== "object") return false;
  const typedExtra = extra as GatewayBatchingRequirement["extra"];
  return (
    typedExtra.name === CIRCLE_BATCHING_NAME &&
    typedExtra.version === CIRCLE_BATCHING_VERSION &&
    typeof typedExtra.verifyingContract === "string"
  );
}

class BrowserGatewayBatchScheme {
  readonly scheme = CIRCLE_BATCHING_SCHEME;

  constructor(
    private readonly walletClient: WalletClient,
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
        nonce: Hex;
      };
      signature: Hex;
    };
  }> {
    const requirements = paymentRequirements as GatewayBatchingRequirement;
    const verifyingContract = requirements.extra?.verifyingContract;
    if (!verifyingContract) {
      throw new Error(
        'Gateway batching option missing extra.verifyingContract.',
      );
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

    const signature = await this.walletClient.signTypedData({
      account: this.payer,
      domain: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        chainId,
        verifyingContract: getAddress(verifyingContract as Address),
      },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });

    return {
      x402Version,
      payload: {
        authorization,
        signature: signature as Hex,
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
  walletClient: WalletClient,
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
    new BrowserGatewayBatchScheme(walletClient, payer),
  );
  return new x402HTTPClient(client);
}

export async function payProtectedResource<TResponse, TBody extends JsonRequestBody>(
  input: PayProtectedResourceInput<TBody>,
): Promise<PayProtectedResourceResult<TResponse>> {
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
      const details =
        typeof data === 'string' ? data : JSON.stringify(data);
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
    input.walletClient,
    input.payer,
    input.chainId,
  );

  input.onAwaitSignature?.();
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
