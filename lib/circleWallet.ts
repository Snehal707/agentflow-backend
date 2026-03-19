import dotenv from 'dotenv';
import { createPublicClient, formatUnits, getAddress, http } from 'viem';
import { getWalletForUser, setWalletForUser } from './walletStore';

dotenv.config();

const ARC_CHAIN_ID = 5042002;
const ARC_TESTNET_BLOCKCHAIN = 'ARC-TESTNET';
const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL || 'https://gateway-api-testnet.circle.com/v1';
const ARC_TESTNET_DOMAIN = Number(process.env.GATEWAY_DOMAIN || 26);
const GATEWAY_CONTRACT_ADDRESS = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const USDC_TOKEN_ADDRESS = '0x3600000000000000000000000000000000000000';
const USDC_DECIMALS = 6;
const MIN_DEPOSIT_FEE_RESERVE_RAW = 8_000n; // 0.008 USDC
const EXTRA_FEE_BUFFER_RAW = 1_000n; // 0.001 USDC

const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

let arcPublicClient: ReturnType<typeof createPublicClient> | null = null;

let dcwClientPromise: Promise<any> | null = null;

function getArcPublicClient() {
  if (!arcPublicClient) {
    arcPublicClient = createPublicClient({
      transport: http(ARC_RPC_URL),
    });
  }
  return arcPublicClient;
}

async function getOnChainUSDCBalanceRaw(walletAddress: string): Promise<bigint> {
  const client = getArcPublicClient();
  return (await client.readContract({
    address: USDC_TOKEN_ADDRESS as `0x${string}`,
    abi: ERC20_READ_ABI,
    functionName: 'balanceOf',
    args: [walletAddress as `0x${string}`],
  })) as bigint;
}

async function getOnChainUSDCAllowanceRaw(
  ownerAddress: string,
  spenderAddress: string,
): Promise<bigint> {
  const client = getArcPublicClient();
  return (await client.readContract({
    address: USDC_TOKEN_ADDRESS as `0x${string}`,
    abi: ERC20_READ_ABI,
    functionName: 'allowance',
    args: [
      ownerAddress as `0x${string}`,
      spenderAddress as `0x${string}`,
    ],
  })) as bigint;
}

function rawUSDCToNumber(amountRaw: bigint): number {
  return Number(formatUnits(amountRaw, USDC_DECIMALS));
}

async function fetchGatewayBalanceForAddress(address: string): Promise<number> {
  try {
    const response = await fetch(`${GATEWAY_API_BASE_URL}/balances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'USDC',
        sources: [{ depositor: address, domain: ARC_TESTNET_DOMAIN }],
      }),
    });

    const json = (await response.json().catch(() => ({}))) as {
      balances?: Array<{ balance?: string }>;
      message?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(json.message || json.error || `HTTP ${response.status}`);
    }

    return Number(json.balances?.[0]?.balance ?? 0);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn(
      `[CircleWallet] Failed to fetch Gateway balance for candidate wallet ${address}:`,
      err?.message ?? err,
    );
    return 0;
  }
}

function feeStringToRawWithCeil(fee: string | undefined): bigint {
  if (!fee) return 0n;

  const parsed = Number(fee);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0n;
  }

  return BigInt(Math.ceil(parsed * 10 ** USDC_DECIMALS));
}

async function estimateFeeReserveRaw(
  dcwClient: any,
  input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: Array<string>;
  },
  label: string,
): Promise<bigint> {
  try {
    const estimateRes = await dcwClient.estimateContractExecutionFee(input as any);
    const feeString =
      estimateRes?.data?.high?.networkFee ??
      estimateRes?.data?.medium?.networkFee ??
      estimateRes?.data?.low?.networkFee;
    const estimatedRaw = feeStringToRawWithCeil(feeString);
    const paddedEstimate = (estimatedRaw * 3n) / 2n + EXTRA_FEE_BUFFER_RAW;
    const reserveRaw =
      paddedEstimate > MIN_DEPOSIT_FEE_RESERVE_RAW
        ? paddedEstimate
        : MIN_DEPOSIT_FEE_RESERVE_RAW;

    // eslint-disable-next-line no-console
    console.log(
      `[CircleWallet] ${label} fee estimate=${feeString ?? 'n/a'} reserveRaw=${reserveRaw.toString()}`,
    );

    return reserveRaw;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn(
      `[CircleWallet] Failed to estimate ${label} fee, falling back to reserve ${MIN_DEPOSIT_FEE_RESERVE_RAW.toString()}:`,
      err?.message ?? err,
    );
    return MIN_DEPOSIT_FEE_RESERVE_RAW;
  }
}

export async function getDCWClient(): Promise<any> {
  if (!dcwClientPromise) {
    dcwClientPromise = (async () => {
      const apiKey = process.env.CIRCLE_API_KEY;
      const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
      if (!apiKey || !entitySecret) {
        throw new Error(
          'CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required for Circle developer-controlled wallets.',
        );
      }

      // Dynamic ESM import so this works from CJS backend.
      const mod = await import('@circle-fin/developer-controlled-wallets');
      const { initiateDeveloperControlledWalletsClient } = mod as any;

      const client = initiateDeveloperControlledWalletsClient({
        apiKey,
        entitySecret,
        environment: 'sandbox',
      });

      // eslint-disable-next-line no-console
      console.log('[CircleWallet] DCW client methods:', Object.keys(client as any));

      return client;
    })();
  }
  return dcwClientPromise;
}

let walletSetId: string | null = process.env.CIRCLE_WALLET_SET_ID || null;

export async function getOrCreateWalletSetId(): Promise<string> {
  if (!walletSetId) {
    throw new Error('CIRCLE_WALLET_SET_ID is required in .env for Circle wallets.');
  }
  return walletSetId;
}

export async function createUserWallet(userLabel: string): Promise<{
  id: string;
  address: string;
}> {
  const setId = await getOrCreateWalletSetId();

  const dcwClient = await getDCWClient();

  const response = await dcwClient.createWallets({
    walletSetId: setId,
    blockchains: [ARC_TESTNET_BLOCKCHAIN],
    count: 1,
    accountType: 'EOA',
    metadata: [
      {
        name: userLabel,
        refId: userLabel,
      },
    ],
  });

  // eslint-disable-next-line no-console
  console.log('[CircleWallet] createWallets response:', response.data);

  const wallet = response.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) {
    throw new Error('Failed to create Circle developer-controlled wallet.');
  }

  if (wallet.blockchain?.chainId && Number(wallet.blockchain.chainId) !== ARC_CHAIN_ID) {
    // eslint-disable-next-line no-console
    console.warn(
      `[CircleWallet] Created wallet on unexpected chainId=${wallet.blockchain.chainId}; expected ${ARC_CHAIN_ID}.`,
    );
  }

  return {
    id: wallet.id,
    address: wallet.address,
  };
}

type CircleWalletCandidate = {
  walletId: string;
  address: string;
  createDate?: string;
  gatewayBalance: number;
};

async function listCircleWalletCandidatesForRefId(refId: string): Promise<CircleWalletCandidate[]> {
  const setId = await getOrCreateWalletSetId();
  const dcwClient = await getDCWClient();
  const response = await dcwClient.listWallets({
    walletSetId: setId,
    refId,
    blockchain: ARC_TESTNET_BLOCKCHAIN,
    pageSize: 50,
    order: 'DESC',
  } as any);

  const wallets = Array.isArray(response?.data?.wallets) ? response.data.wallets : [];
  const candidates = wallets.filter(
    (wallet: any) =>
      wallet?.id &&
      wallet?.address &&
      wallet?.blockchain === ARC_TESTNET_BLOCKCHAIN &&
      (wallet?.state === 'LIVE' || !wallet?.state) &&
      (wallet?.accountType === 'EOA' || !wallet?.accountType),
  );

  return Promise.all(
    candidates.map(async (wallet: any) => ({
      walletId: wallet.id as string,
      address: wallet.address as string,
      createDate: typeof wallet.createDate === 'string' ? wallet.createDate : undefined,
      gatewayBalance: await fetchGatewayBalanceForAddress(wallet.address as string),
    })),
  );
}

async function findRemoteCircleWalletForUser(userAddress: string): Promise<{
  walletId: string;
  address: string;
} | null> {
  const normalized = getAddress(userAddress);
  const refIds = Array.from(new Set([normalized, normalized.toLowerCase()]));
  const candidatesById = new Map<string, CircleWalletCandidate>();

  for (const refId of refIds) {
    const candidates = await listCircleWalletCandidatesForRefId(refId);
    for (const candidate of candidates) {
      candidatesById.set(candidate.walletId, candidate);
    }
  }

  const candidates = Array.from(candidatesById.values());
  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => {
    if (b.gatewayBalance !== a.gatewayBalance) {
      return b.gatewayBalance - a.gatewayBalance;
    }
    const aDate = a.createDate ? Date.parse(a.createDate) : 0;
    const bDate = b.createDate ? Date.parse(b.createDate) : 0;
    return bDate - aDate;
  });

  const selected = candidates[0];

  if (candidates.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[CircleWallet] Found ${candidates.length} wallets for ${normalized}; selecting ${selected.address} with gatewayBalance=${selected.gatewayBalance}.`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[CircleWallet] Recovered existing Circle wallet ${selected.address} for ${normalized} from Circle.`,
    );
  }

  setWalletForUser(normalized, {
    circleWalletId: selected.walletId,
    circleWalletAddress: selected.address,
  });

  return {
    walletId: selected.walletId,
    address: selected.address,
  };
}

export async function findCircleWalletForUser(userAddress: string): Promise<{
  walletId: string;
  address: string;
} | null> {
  const normalized = getAddress(userAddress);
  const stored = getWalletForUser(userAddress);
  if (stored?.circleWalletId && stored?.circleWalletAddress) {
    return {
      walletId: stored.circleWalletId,
      address: stored.circleWalletAddress,
    };
  }

  return findRemoteCircleWalletForUser(normalized);
}

export async function getCircleWalletForUser(userAddress: string): Promise<{
  walletId: string;
  address: string;
}> {
  const resolved = await findCircleWalletForUser(userAddress);
  if (!resolved) {
    throw new Error('Circle wallet not found for user');
  }

  return {
    walletId: resolved.walletId,
    address: resolved.address,
  };
}

/**
 * Low-level helper for x402 server client: sign arbitrary EIP-712 typed data
 * with a Circle dev-controlled wallet.
 */
export async function signTypedDataWithCircleWallet(
  walletId: string,
  typedData: Record<string, unknown>,
): Promise<string> {
  const dcwClient = await getDCWClient();

  // eslint-disable-next-line no-console
  console.log(
    '[CircleWallet] data sent to signTypedData:',
    JSON.stringify(
      typedData,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );

  const response = await dcwClient.signTypedData({
    walletId,
    data: JSON.stringify(typedData, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  });

  const maybeSig = response?.data?.signature ?? response?.data?.signedData?.signature;
  if (!maybeSig || typeof maybeSig !== 'string') {
    throw new Error('Circle signTypedData did not return a signature');
  }
  return maybeSig;
}

async function waitForTransactionCompletion(
  dcwClient: any,
  id: string | undefined,
  label: string,
  maxAttempts = 15,
  delayMs = 2000,
): Promise<{
  id: string | undefined;
  state: string | undefined;
  errorReason?: string;
  errorDetails?: string;
  txHash?: string;
}> {
  if (!id) {
    return { id: undefined, state: undefined };
  }

  // eslint-disable-next-line no-console
  console.log(`[CircleWallet] Waiting for ${label} tx ${id} to complete...`);

  let lastTransaction: any;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await dcwClient.getTransaction({ id });
    const tx = res.data?.transaction;
    lastTransaction = tx;
    const state = tx?.state as string | undefined;

    // eslint-disable-next-line no-console
    console.log(`[CircleWallet] ${label} tx poll #${attempt + 1}: state=${state}`);

    if (!state || state === 'COMPLETE' || state === 'FAILED' || state === 'ERROR') {
      return {
        id,
        state,
        errorReason: tx?.errorReason,
        errorDetails: tx?.errorDetails,
        txHash: tx?.txHash,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return {
    id,
    state: lastTransaction?.state ?? 'PENDING_TIMEOUT',
    errorReason: lastTransaction?.errorReason,
    errorDetails: lastTransaction?.errorDetails,
    txHash: lastTransaction?.txHash,
  };
}

/**
 * Returns the Circle wallet's USDC balance in human-readable units (e.g. 0.9).
 * Uses the Circle DCW API wallet balances endpoint.
 */
export async function getCircleWalletUSDCBalance(walletId: string): Promise<number> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) return 0;

  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) return 0;

  const json = (await res.json()) as {
    data?: { tokenBalances?: Array<{ token?: { symbol?: string }; amount?: string }> };
  };

  const usdcEntry = json.data?.tokenBalances?.find(
    (t) => t.token?.symbol === 'USDC',
  );

  return Number(usdcEntry?.amount ?? 0);
}

/**
 * Transfer USDC from a dev-controlled wallet to the Circle Gateway contract on Arc Testnet.
 * Performs two steps using Circle DCW:
 * 1) approve(USDC -> Gateway)
 * 2) deposit(USDC into Gateway)
 *
 * We intentionally do not try to deposit the wallet's full pre-approval balance.
 * On Arc Testnet the contract execution fees are deducted from the wallet's USDC balance,
 * so the approval transaction itself lowers the spendable amount available for deposit.
 */
export async function transferToGateway(params: {
  walletId: string;
  walletAddress: string;
}): Promise<{
  transferId: string | undefined;
  status: string;
  approvalId?: string;
  approvalState?: string;
  approvalTxHash?: string;
  depositId?: string;
  depositState?: string;
  depositTxHash?: string;
  amount?: number;
  amountRaw?: string;
  errorReason?: string;
  errorDetails?: string;
}> {
  const { walletId, walletAddress } = params;

  const dcwClient = await getDCWClient();
  const currentBalanceRaw = await getOnChainUSDCBalanceRaw(walletAddress);

  // eslint-disable-next-line no-console
  console.log(
    `[CircleWallet] On-chain wallet USDC balance before funding: ${currentBalanceRaw.toString()} (${rawUSDCToNumber(currentBalanceRaw)} USDC)`,
  );

  if (currentBalanceRaw <= 0n) {
    return {
      transferId: undefined,
      status: 'NO_FUNDS',
      errorReason: 'INSUFFICIENT_TOKEN',
      errorDetails: 'Circle wallet has no on-chain USDC balance to deposit into Gateway.',
    };
  }

  const currentAllowanceRaw = await getOnChainUSDCAllowanceRaw(
    walletAddress,
    GATEWAY_CONTRACT_ADDRESS,
  );

  // eslint-disable-next-line no-console
  console.log(
    `[CircleWallet] Current Gateway allowance: ${currentAllowanceRaw.toString()} raw units`,
  );

  // Step 1: approve Gateway contract to spend USDC
  let approvalResult:
    | {
        id: string | undefined;
        state: string | undefined;
        errorReason?: string;
        errorDetails?: string;
        txHash?: string;
      }
    | undefined;

  if (currentAllowanceRaw < currentBalanceRaw) {
    let approvalTx: any;
    try {
      const approvalRes = await dcwClient.createContractExecutionTransaction({
        walletId,
        contractAddress: USDC_TOKEN_ADDRESS,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters: [GATEWAY_CONTRACT_ADDRESS, currentBalanceRaw.toString()],
        fee: {
          type: 'level',
          config: { feeLevel: 'HIGH' },
        },
      } as any);

      // eslint-disable-next-line no-console
      console.log(
        '[CircleWallet] Full approval response:',
        JSON.stringify(approvalRes?.data, null, 2),
      );

      approvalTx = approvalRes.data?.transaction ?? approvalRes.data;
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(
        '[CircleWallet] Approval error:',
        err?.message,
        err?.code,
        err?.status,
      );
      throw err;
    }

    const approvalId = approvalTx?.id as string | undefined;

    approvalResult = await waitForTransactionCompletion(
      dcwClient,
      approvalId,
      'approval',
    );

    if (approvalResult.state !== 'COMPLETE') {
      return {
        transferId: approvalResult.id,
        status: approvalResult.state ?? 'unknown',
        approvalId: approvalResult.id,
        approvalState: approvalResult.state,
        approvalTxHash: approvalResult.txHash,
        errorReason: approvalResult.errorReason,
        errorDetails: approvalResult.errorDetails,
      };
    }
  } else {
    approvalResult = {
      id: undefined,
      state: 'SKIPPED_ALREADY_APPROVED',
    };
  }

  const postApprovalBalanceRaw = await getOnChainUSDCBalanceRaw(walletAddress);
  const depositFeeReserveRaw = await estimateFeeReserveRaw(
    dcwClient,
    {
      walletId,
      contractAddress: GATEWAY_CONTRACT_ADDRESS,
      abiFunctionSignature: 'deposit(address,uint256)',
      abiParameters: [
        USDC_TOKEN_ADDRESS,
        postApprovalBalanceRaw.toString(),
      ],
    },
    'deposit',
  );
  const depositAmountRaw =
    postApprovalBalanceRaw > depositFeeReserveRaw
      ? postApprovalBalanceRaw - depositFeeReserveRaw
      : 0n;

  // eslint-disable-next-line no-console
  console.log(
    `[CircleWallet] Post-approval balance=${postApprovalBalanceRaw.toString()} reserve=${depositFeeReserveRaw.toString()} depositAmount=${depositAmountRaw.toString()}`,
  );

  if (depositAmountRaw <= 0n) {
    return {
      transferId: undefined,
      status: 'INSUFFICIENT_FUNDS_FOR_DEPOSIT_FEE',
      approvalId: approvalResult.id,
      approvalState: approvalResult.state,
      approvalTxHash: approvalResult.txHash,
      amount: 0,
      amountRaw: '0',
      errorReason: 'INSUFFICIENT_TOKEN',
      errorDetails:
        'Not enough USDC remains after approval to both pay the deposit fee and move funds into Gateway.',
    };
  }

  // Step 2: call deposit(token, value) on the Gateway contract
  let depositTx: any;
  try {
    const depositRes = await dcwClient.createContractExecutionTransaction({
      walletId,
      contractAddress: GATEWAY_CONTRACT_ADDRESS,
      abiFunctionSignature: 'deposit(address,uint256)',
      abiParameters: [USDC_TOKEN_ADDRESS, depositAmountRaw.toString()],
      fee: {
        type: 'level',
        config: { feeLevel: 'HIGH' },
      },
    } as any);

    // eslint-disable-next-line no-console
    console.log(
      '[CircleWallet] Deposit response:',
      JSON.stringify(depositRes?.data, null, 2),
    );

    depositTx = depositRes.data?.transaction ?? depositRes.data;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(
      '[CircleWallet] Deposit/transfer error:',
      err?.message,
      err?.code,
      err?.status,
    );
    throw err;
  }

  const depositId = depositTx?.id as string | undefined;

  const depositResult = await waitForTransactionCompletion(
    dcwClient,
    depositId,
    'deposit',
  );

  return {
    transferId: depositResult.id,
    status: depositResult.state ?? 'unknown',
    approvalId: approvalResult.id,
    approvalState: approvalResult.state,
    approvalTxHash: approvalResult.txHash,
    depositId: depositResult.id,
    depositState: depositResult.state,
    depositTxHash: depositResult.txHash,
    amount: rawUSDCToNumber(depositAmountRaw),
    amountRaw: depositAmountRaw.toString(),
    errorReason: depositResult.errorReason,
    errorDetails: depositResult.errorDetails,
  };
}

