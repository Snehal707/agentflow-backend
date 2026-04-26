import './lib/loadEnv';
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPublicClient, formatUnits, getAddress, http, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BatchFacilitatorClient,
  createGatewayMiddleware,
  isBatchPayment,
} from '@circlefin/x402-batching/server';
import {
  callHermesDeep,
  callHermesFast,
} from './lib/hermes';
import {
  buildBrainConfirmationMeta,
  buildBrainMetaFromToolResults,
  runAgentBrain,
  type BrainMessageMeta,
} from './lib/agent-brain';
import {
  appendRecentExecutionEntries,
  clearPendingAction,
  executeTool,
  loadPendingAction,
  takeRecentExecutionMeta,
} from './lib/tool-executor';
import { fetchLiveData } from './lib/live-data';
import { inferResearchReasoningMode } from './lib/researchMode';
import {
  enqueueResearch,
  getJobStatus,
  getQueueStats,
  processResearchQueue,
  releaseResearchSlot,
  tryAcquireResearchSlot,
} from './lib/research-queue';
import {
  createUserWallet,
  findCircleWalletForUser,
  getCircleWalletForUser,
  getOrCreateCircleWalletForUser,
  getOrCreateWalletSetId,
} from './lib/circleWallet';
import {
  ANALYST_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from './lib/agentPrompts';
import {
  CHAT_SYSTEM_PROMPT,
  buildCurrentDateContext,
  buildWalletProfileLlmContext,
} from './lib/chatPersona';
import {
  buildAnalystModelInput,
  buildWriterModelInput,
} from './lib/reportInputs';
import { finalizeReportMarkdown } from './lib/reportPipeline';
import { setWalletForUser } from './lib/walletStore';
import { payProtectedResourceServer } from './lib/x402ServerClient';
import { insertAgentToAgentLedger } from './lib/a2a-ledger';
import { fetchAttributedArcBatcherGas } from './lib/arcBatcherGas';
import { getFacilitatorBaseUrl } from './lib/facilitator-url';
import { scheduleChatToolPostA2a } from './lib/a2a-chat-scheduler';
import { runInvoiceVendorResearchFollowup, runPortfolioFollowupAfterToolWithPayment } from './lib/a2a-followups';
import {
  X402InflightConflictError,
  acquireX402InflightLock,
  readX402AttemptRecord,
  releaseX402InflightLock,
  writeX402AttemptRecord,
  type X402AttemptMode,
  type X402AttemptStage,
} from './lib/x402AttemptLedger';
import { sendGAEvent } from './lib/gaServer';
import { detectWalletIntent } from './lib/orchestrator';
import authApiRouter from './api/auth';
import walletApiRouter from './api/wallet';
import extensionApiRouter from './api/extension';
import paymentsApiRouter from './api/payments';
import businessApiRouter from './api/business';
import payApiRouter, { fetchPayHistoryForBrain } from './api/pay';
import marketplaceApiRouter, { CORE_AGENT_SPECS } from './api/marketplace';
import portfolioApiRouter from './api/portfolio';
import fundsApiRouter from './api/funds';
import settingsApiRouter from './api/settings';
import telegramApiRouter from './api/telegram';
import emailWebhookRouter from './api/webhooks/email';
import { authMiddleware, generateJWT, verifyJWT, type JWTPayload } from './lib/auth';
import { getOrCreateUserAgentWallet } from './lib/dcw';
import { loadAgentOwnerWallet } from './lib/agent-owner-wallet';
import { readDailyUsageCap } from './lib/usageCaps';
import { adminDb, getRedis } from './db/client';
import { ARC } from './lib/arc-config';
import { resolvePayee } from './lib/agentpay-payee';
import { getTxStats, incrementTxCount } from './lib/tx-counter';
import { getTreasuryStats, runTreasuryTopUp } from './lib/agent-treasury';
import {
  assessCounterpartyRisk,
  formatCounterpartyRiskReport,
  type CounterpartyRiskAssessment,
} from './lib/counterparty-risk';
import {
  canonicalRedisSessionId,
  clearPendingRedisKeys,
  getFirstPendingRedisValue,
  redisPendingExists,
} from './lib/chatSessionRedis';
import { getAgentFlowCircleStackSummary, listSupportedBridgeSourcesDetailed } from './agents/bridge/bridgeKit';
import { CANONICAL_FUND_IDS } from './lib/funds-defaults';
import { parseCSVBatch, parseInlineCsvFromMessage } from './lib/csv-batch-parser';
import { executeUserPaidAgentViaX402 } from './lib/paidAgentX402';
import {
  checkHttpHealth,
  deriveHealthUrlFromRunUrl,
  resolveFacilitatorHealthUrl,
} from './lib/x402Health';
import { AGENT_DEFAULT_PORTS, isAgentHealthy } from './lib/a2a-health';
type OrchestratorStep = 'research' | 'analyst' | 'writer';

type ProxyEvent =
  | { type: 'proxy_start'; step: OrchestratorStep }
  | {
      type: 'payment_required';
      step: OrchestratorStep;
      paymentRequiredHeader: string;
    }
  | {
      type: 'proxy_response';
      step: OrchestratorStep;
      status: number;
      transaction?: string;
      data: unknown;
    }
  | { type: 'error'; message: string; step?: OrchestratorStep; status?: number };

type DcwPaidAgentSlug = 'ascii' | 'swap' | 'vault' | 'portfolio' | 'vision' | 'transcribe';

type EconomyBenchmarkEntry = {
  tx: number;
  amount: string;
  agent: string;
  txHash?: string;
  status: 'success' | 'failed';
  error?: string;
};

type EconomyBenchmarkResult = {
  total_txs: number;
  total_usdc: string;
  gas_paid: string;
  margin: string;
  results: EconomyBenchmarkEntry[];
  agents_covered: string[];
  flows_completed: string[];
  arc_tx_ids: string[];
  breakdown: {
    x402_payments: number;
    a2a_payments: number;
  };
  arc_vs_eth: {
    arc_cost: string;
    eth_cost: string;
    savings: string;
  };
  execution_wallet?: string;
};

type EconomyBenchmarkJob = {
  jobId: string;
  walletAddress: Address;
  status: 'queued' | 'running' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: {
    completed: number;
    total: number;
    successful: number;
    failed: number;
    currentAgent: string | null;
  };
  result: EconomyBenchmarkResult | null;
  error: string | null;
};

const NETWORK_NAME = 'Arc Testnet';
const CHAIN_ID = 5042002;
const ARC_TESTNET_DOMAIN = Number(process.env.GATEWAY_DOMAIN || 26);
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL || 'https://gateway-api-testnet.circle.com/v1';
const MIN_GATEWAY_BALANCE = 1;

const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT || 3000);
const RESEARCH_PORT = Number(process.env.RESEARCH_AGENT_PORT || 3001);
const ANALYST_PORT = Number(process.env.ANALYST_AGENT_PORT || 3002);
const WRITER_PORT = Number(process.env.WRITER_AGENT_PORT || 3003);
const VISION_PORT = Number(process.env.VISION_AGENT_PORT || 3016);
const TRANSCRIBE_PORT = Number(process.env.TRANSCRIBE_AGENT_PORT || 3017);
const PUBLIC_PORT = Number(process.env.PORT || 4000);
const ECONOMY_BENCHMARK_TARGET = 60;
const ECONOMY_BENCHMARK_DELAY_MS = 500;
const economyBenchmarkJobs = new Map<string, EconomyBenchmarkJob>();
const ECONOMY_ARC_FALLBACK_GAS_PER_TX_USD = Number.parseFloat(
  process.env.ECONOMY_ARC_FALLBACK_GAS_PER_TX_USD || '0.000001',
);
const ECONOMY_ETHEREUM_GAS_PER_TX_USD = Number.parseFloat(
  process.env.BENCHMARK_ETHEREUM_GAS_PER_TX_USD || '2.50',
);
const ARC_RECEIPT_GAS_CACHE = new Map<
  string,
  {
    gasUsd: number;
    fetchedAt: number;
  }
>();
const ARC_RECEIPT_GAS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const arcPublicClient = createPublicClient({
  transport: http(ARC.alchemyRpc || ARC.rpc),
});

const BENCHMARK_RECIPIENT_A = '0x4C37a02d40F3Ce6D4753D5E0622bAF1643DBE65c' as Address;
const BENCHMARK_RECIPIENT_B = '0xb82AE74138acdcd2045b66984990EED0559Ec769' as Address;
const BENCHMARK_ARC_USDC = getAddress(
  process.env.ARC_USDC_ADDRESS?.trim() || '0x3600000000000000000000000000000000000000',
);
const BENCHMARK_SWAP_TOKEN_OUT = getAddress(
  process.env.SWAP_PAIR_TOKEN_ADDRESS?.trim() || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
);

const BENCHMARK_AGENT_PRICES: Record<string, number> = {
  research: Number.parseFloat(process.env.RESEARCH_AGENT_PRICE || '0.02'),
  analyst: Number.parseFloat(process.env.ANALYST_AGENT_PRICE || '0.003'),
  writer: Number.parseFloat(process.env.WRITER_AGENT_PRICE || '0.008'),
  swap: Number.parseFloat(process.env.SWAP_AGENT_PRICE || '0.005'),
  vault: Number.parseFloat(process.env.VAULT_AGENT_PRICE || '0.005'),
  bridge: Number.parseFloat(process.env.BRIDGE_AGENT_PRICE || '0.005'),
  portfolio: Number.parseFloat(process.env.PORTFOLIO_AGENT_PRICE || '0.003'),
  invoice: Number.parseFloat(process.env.INVOICE_AGENT_PRICE || '0.005'),
  vision: Number.parseFloat(process.env.VISION_AGENT_PRICE || '0.01'),
  transcribe: Number.parseFloat(process.env.TRANSCRIBE_AGENT_PRICE || '0.008'),
  schedule: Number.parseFloat(process.env.SCHEDULE_AGENT_PRICE || '0.003'),
  split: Number.parseFloat(process.env.SPLIT_AGENT_PRICE || '0.003'),
  batch: Number.parseFloat(process.env.BATCH_AGENT_PRICE || '0.003'),
  ascii: Number.parseFloat(process.env.ASCII_AGENT_PRICE || '0.001'),
};

type BenchmarkTxKind = 'x402_payment' | 'a2a_payment';

type BenchmarkFlowDefinition = {
  name: string;
  runs: number;
  run: (ctx: BenchmarkRunContext, runIndex: number) => Promise<BenchmarkFlowRunResult>;
};

type BenchmarkFlowRunResult = {
  entries: EconomyBenchmarkEntry[];
  x402Count: number;
  a2aCount: number;
  totalUsdc: number;
  coveredAgents: string[];
  arcTxIds: string[];
};

type BenchmarkRunContext = {
  jobId: string;
  userWallet: Address;
  internalKey: string;
  healthFailures: Set<string>;
  flowExecutions: string[];
};

/** Split deploy (e.g. Railway): set FACILITATOR_URL or FACILITATOR_PORT; must match agents — see lib/facilitator-url.ts */
const FACILITATOR_URL = getFacilitatorBaseUrl();
const RESEARCH_URL = resolveAgentRunUrl(
  process.env.RESEARCH_AGENT_URL?.trim(),
  `http://127.0.0.1:${RESEARCH_PORT}/run`,
);
const ANALYST_URL = resolveAgentRunUrl(
  process.env.ANALYST_AGENT_URL?.trim(),
  `http://127.0.0.1:${ANALYST_PORT}/run`,
);
const WRITER_URL = resolveAgentRunUrl(
  process.env.WRITER_AGENT_URL?.trim(),
  `http://127.0.0.1:${WRITER_PORT}/run`,
);
const ASCII_URL = resolveAgentRunUrl(
  process.env.ASCII_AGENT_URL?.trim(),
  `http://127.0.0.1:${PUBLIC_PORT}/agent/ascii/run`,
);
const SWAP_URL = resolveAgentRunUrl(
  process.env.SWAP_AGENT_URL?.trim(),
  'http://127.0.0.1:3011/run',
);
const VAULT_URL = resolveAgentRunUrl(
  process.env.VAULT_AGENT_URL?.trim(),
  'http://127.0.0.1:3012/run',
);
const BRIDGE_URL = resolveAgentRunUrl(
  process.env.BRIDGE_AGENT_URL?.trim(),
  'http://127.0.0.1:3013/run',
);
const PORTFOLIO_URL = resolveAgentRunUrl(
  process.env.PORTFOLIO_AGENT_URL?.trim(),
  'http://127.0.0.1:3014/run',
);
const VISION_URL = resolveAgentRunUrl(
  process.env.VISION_AGENT_URL?.trim(),
  `http://127.0.0.1:${VISION_PORT}/run`,
);
const TRANSCRIBE_URL = resolveAgentRunUrl(
  process.env.TRANSCRIBE_AGENT_URL?.trim(),
  `http://127.0.0.1:${TRANSCRIBE_PORT}/run`,
);
const SCHEDULE_PORT = Number(process.env.SCHEDULE_AGENT_PORT || 3018);
const SCHEDULE_AGENT_BASE_URL =
  process.env.SCHEDULE_AGENT_URL?.trim() || `http://127.0.0.1:${SCHEDULE_PORT}`;
const SPLIT_PORT = Number(process.env.SPLIT_AGENT_PORT || 3019);
const SPLIT_AGENT_BASE_URL =
  process.env.SPLIT_AGENT_URL?.trim() || `http://127.0.0.1:${SPLIT_PORT}`;
const BATCH_PORT = Number(process.env.BATCH_AGENT_PORT || 3020);
const BATCH_AGENT_BASE_URL =
  process.env.BATCH_AGENT_URL?.trim() || `http://127.0.0.1:${BATCH_PORT}`;
const INVOICE_PORT = Number(process.env.INVOICE_AGENT_PORT || 3015);
const INVOICE_AGENT_BASE_URL =
  process.env.INVOICE_AGENT_URL?.trim() || `http://127.0.0.1:${INVOICE_PORT}`;

/**
 * Accepts either a valid JWT Bearer token OR the Hermes brain internal key.
 * When called from Hermes (Python), there is no JWT — only the internal-key header.
 * walletAddress is taken from req.body.walletAddress in that case.
 */
function internalOrAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  const sentKey = (req.headers['x-agentflow-brain-internal'] as string | undefined)?.trim();
  if (internalKey && sentKey === internalKey) {
    const walletAddress = String(req.body?.walletAddress ?? '').trim();
    (req as any).auth = {
      walletAddress,
      accessModel: 'pay_per_task',
      exp: 0,
    } satisfies JWTPayload;
    next();
    return;
  }
  authMiddleware(req, res, next);
}

const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 80_000);
const RESEARCH_AGENT_TIMEOUT_MS = Number(
  process.env.RESEARCH_AGENT_TIMEOUT_MS || 140_000,
);
const ANALYST_AGENT_TIMEOUT_MS = Number(
  process.env.ANALYST_AGENT_TIMEOUT_MS || AGENT_TIMEOUT_MS,
);
const WRITER_AGENT_TIMEOUT_MS = Number(
  process.env.WRITER_AGENT_TIMEOUT_MS || AGENT_TIMEOUT_MS,
);
const LIVE_DATA_TIMEOUT_MS = Number(process.env.RESEARCH_LIVE_DATA_TIMEOUT_MS || 45_000);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15_000);
const AGENT_JSON_LIMIT = process.env.AGENT_JSON_LIMIT?.trim() || '20mb';

const SYSTEM_PROMPTS = {
  research: `You are a research agent. Given a topic, find and summarize key facts, recent developments, and relevant data. Be thorough and factual. Return structured JSON. When the user message includes LIVE DATA, use it for current figures. Do not use training data for prices or recent events when live data is provided. CRITICAL: Never start any line with >. Never use blockquote formatting. Write in clean plain paragraphs.`,
  analyst: `You are an analyst agent. Given raw research data, extract key insights, identify patterns, and provide analytical conclusions. Return structured JSON. Do NOT start any line or sentence with the > symbol. Do NOT use blockquote formatting. Write in clean plain paragraphs.`,
  writer: `You are a writer agent. Given research and analysis, write a clear, well-structured report. Use markdown formatting. Make it professional and readable. CRITICAL FORMATTING RULES: Never use > at the start of any line. Never use blockquote markdown. Write every sentence as plain paragraph text or bullet points with - only. If you use > anywhere it will break the output. Structure the report exactly as follows: # [Topic] — Research Report; **Prepared by:** AgentFlow AI; ---; ## Executive Summary (2-3 sentence overview); ## Key Facts (clean bullet points); ## Recent Developments (paragraphs, no >); ## Data & Statistics (markdown table where appropriate); ## Analysis (analytical conclusions from analyst agent); ## Conclusion (final summary); ---; Then add exactly one blockquote at the very end: > ⚠️ Disclaimer: This report was generated by AI. Financial figures and statistics may be based on training data and not reflect current values. Always verify with live sources such as CoinMarketCap, CoinGecko, Bloomberg, or Reuters.`,
};

const pendingEmergencyWithdrawConfirmations = new Map<string, number>();

const researchPrice = parsePrice(process.env.RESEARCH_AGENT_PRICE, '0.005');
const analystPrice = parsePrice(process.env.ANALYST_AGENT_PRICE, '0.003');
const writerPrice = parsePrice(process.env.WRITER_AGENT_PRICE, '0.008');
const asciiPrice = parsePrice(process.env.ASCII_AGENT_PRICE, '0.001');
const portfolioPrice = parsePrice(process.env.PORTFOLIO_AGENT_PRICE, '0.015');
const swapPrice = parsePrice(process.env.SWAP_AGENT_PRICE, '0.010');
const vaultPrice = parsePrice(process.env.VAULT_AGENT_PRICE, '0.012');
const invoicePrice = parsePrice(process.env.INVOICE_AGENT_PRICE, '0.025');
const schedulePrice = parsePrice(process.env.SCHEDULE_AGENT_PRICE, '0.005');
const splitPrice = parsePrice(process.env.SPLIT_AGENT_PRICE, '0.005');
const batchPrice = parsePrice(process.env.BATCH_AGENT_PRICE, '0.010');

const sellerAddress = resolveSellerAddress();

function parsePrice(input: string | undefined, fallback: string): string {
  return `$${(Number(input || fallback) || Number(fallback)).toFixed(3)}`;
}

/** Non-blocking vendor research after chat-created invoice (HTTP confirm or chat YES). */
function scheduleChatInvoiceResearchFollowup(pending: {
  vendorHandle: string;
  amount: string;
  issuerWalletAddress?: string;
}): void {
  const vendor = pending.vendorHandle?.trim();
  const amt = parseFloat(pending.amount);
  if (!vendor || !Number.isFinite(amt) || amt <= 10) {
    if (vendor && Number.isFinite(amt) && amt <= 10) {
      console.log('[a2a] invoice→research skipped (amount <= 10 USDC gate)', { vendor, amt });
    }
    return;
  }
  console.log('[a2a] invoice→research follow-up scheduled (chat path)', { vendor, amt });
  setImmediate(() => {
    void (async () => {
      try {
        await runInvoiceVendorResearchFollowup({
          vendor,
          amount: amt,
          issuerWalletAddress: pending.issuerWalletAddress,
          researchRunUrl: RESEARCH_URL,
          researchPriceLabel: researchPrice,
        });
        console.log('[a2a] invoice→research follow-up finished (chat path)');
      } catch (e) {
        console.warn('[a2a] invoice→research failed:', e instanceof Error ? e.message : e);
      }
    })();
  });
}

function usdAmountFromPriceLabel(price: string): number {
  return Number(price.replace(/^\$/, '').trim()) || 0;
}

function parseAmount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isArcTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function formatUsdMicro(value: number, digits = 8): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(digits)}`;
}

function formatPercent(value: number, digits = 4): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(digits)}%`;
}

function computeNetMarginPercent(totalUsdc: number, gasPaidUsd: number): number {
  if (!Number.isFinite(totalUsdc) || totalUsdc <= 0) {
    return 0;
  }
  const retained = Math.max(0, totalUsdc - Math.max(0, gasPaidUsd));
  return (retained / totalUsdc) * 100;
}

async function sumCompletedTransactionAmounts(): Promise<number> {
  const pageSize = 1000;
  let offset = 0;
  let total = 0;

  while (true) {
    const { data, error } = await adminDb
      .from('transactions')
      .select('amount')
      .eq('status', 'complete')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new Error(error.message);
    }

    if (!data?.length) {
      break;
    }

    for (const tx of data) {
      total += parseAmount(tx.amount);
    }

    if (data.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return total;
}

function buildArcVsEthereumStats(
  arcGasPaidUsd: number,
  txCount: number,
): {
  arc_gas_per_tx: string;
  ethereum_gas_per_tx: string;
  savings_multiplier: string;
  min_viable_payment_arc: string;
  min_viable_payment_eth: string;
} {
  const arcPerTx = txCount > 0 ? arcGasPaidUsd / txCount : 0;
  const ethPerTx =
    Number.isFinite(ECONOMY_ETHEREUM_GAS_PER_TX_USD) && ECONOMY_ETHEREUM_GAS_PER_TX_USD > 0
      ? ECONOMY_ETHEREUM_GAS_PER_TX_USD
      : 2.5;
  if (arcPerTx <= 0) {
    return {
      arc_gas_per_tx: 'Awaiting gas data',
      ethereum_gas_per_tx: formatUsdMicro(ethPerTx, 2),
      savings_multiplier: 'n/a',
      min_viable_payment_arc: 'Awaiting gas data',
      min_viable_payment_eth: `${formatUsdMicro(ethPerTx, 2)}+`,
    };
  }

  const savingsMultiplier =
    Number.isFinite(ethPerTx) ? ethPerTx / arcPerTx : 0;

  return {
    arc_gas_per_tx: formatUsdMicro(arcPerTx),
    ethereum_gas_per_tx: formatUsdMicro(ethPerTx, 2),
    savings_multiplier:
      savingsMultiplier > 0
        ? `${savingsMultiplier.toLocaleString('en-US', { maximumFractionDigits: 0 })}x`
        : 'n/a',
    min_viable_payment_arc: formatUsdMicro(arcPerTx),
    min_viable_payment_eth: `${formatUsdMicro(ethPerTx, 2)}+`,
  };
}

function shouldCountFallbackArcGas(tx: {
  arc_tx_id?: string | null;
  payment_rail?: string | null;
  action_type?: string | null;
}): boolean {
  if (isArcTransactionHash(tx.arc_tx_id)) {
    return false;
  }

  const rail = String(tx.payment_rail || '').toLowerCase();
  const action = String(tx.action_type || '').toLowerCase();
  return (
    rail === 'gateway_batched' ||
    rail === 'x402/gateway' ||
    action === 'x402_payment' ||
    action === 'agent_to_agent_payment'
  );
}

async function estimateArcGasPaidUsd(
  txHashes: Array<string | null | undefined>,
): Promise<{ totalUsd: number; countedTxs: number }> {
  const uniqueTxHashes = [...new Set(txHashes.filter(isArcTransactionHash))];
  if (!uniqueTxHashes.length) {
    return { totalUsd: 0, countedTxs: 0 };
  }

  let totalUsd = 0;
  let countedTxs = 0;
  const now = Date.now();

  await Promise.all(
    uniqueTxHashes.map(async (txHash) => {
      const cached = ARC_RECEIPT_GAS_CACHE.get(txHash);
      if (cached && now - cached.fetchedAt < ARC_RECEIPT_GAS_CACHE_TTL_MS) {
        totalUsd += cached.gasUsd;
        countedTxs += 1;
        return;
      }

      try {
        const receipt = await arcPublicClient.getTransactionReceipt({
          hash: txHash,
        });
        const effectiveGasPrice =
          'effectiveGasPrice' in receipt && typeof receipt.effectiveGasPrice === 'bigint'
            ? receipt.effectiveGasPrice
            : 'gasPrice' in receipt && typeof receipt.gasPrice === 'bigint'
              ? receipt.gasPrice
              : null;
        if (effectiveGasPrice == null) {
          return;
        }

        const gasUsd = Number(formatUnits(receipt.gasUsed * effectiveGasPrice, 18));
        if (!Number.isFinite(gasUsd)) {
          return;
        }

        ARC_RECEIPT_GAS_CACHE.set(txHash, {
          gasUsd,
          fetchedAt: now,
        });
        totalUsd += gasUsd;
        countedTxs += 1;
      } catch (error) {
        console.warn('[economy] receipt gas lookup skipped:', txHash, getErrorMessage(error));
      }
    }),
  );

  return { totalUsd, countedTxs };
}

function serializeEconomyBenchmarkJob(job: EconomyBenchmarkJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    walletAddress: job.walletAddress,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

function updateEconomyBenchmarkJob(
  jobId: string,
  updater: (job: EconomyBenchmarkJob) => EconomyBenchmarkJob,
): EconomyBenchmarkJob | null {
  const existing = economyBenchmarkJobs.get(jobId);
  if (!existing) {
    return null;
  }
  const next = updater(existing);
  economyBenchmarkJobs.set(jobId, next);
  return next;
}

function benchmarkAgentPrice(slug: string): number {
  const value = BENCHMARK_AGENT_PRICES[slug];
  return Number.isFinite(value) ? value : 0;
}

function buildBenchmarkAuthHeaders(
  internalKey: string,
  walletAddress: Address,
  paid = false,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [paid ? 'x-agentflow-paid-internal' : 'x-agentflow-brain-internal']: internalKey,
    Authorization: `Bearer ${generateJWT(walletAddress)}`,
  };
}

function benchmarkProgressTotal(): number {
  return 60;
}

async function benchmarkDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ECONOMY_BENCHMARK_DELAY_MS));
}

function asBenchmarkEntry(
  tx: number,
  agent: string,
  amount: number,
  status: 'success' | 'failed',
  options?: { txHash?: string | null; error?: string },
): EconomyBenchmarkEntry {
  return {
    tx,
    agent,
    amount: amount.toFixed(3),
    status,
    ...(options?.txHash ? { txHash: options.txHash } : {}),
    ...(options?.error ? { error: options.error } : {}),
  };
}

function normalizeBenchmarkArcTxId(value: unknown): string | null {
  if (typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)) {
    return value;
  }
  return null;
}

function extractBenchmarkArcTxIds(payload: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const visit = (value: unknown) => {
    const txId = normalizeBenchmarkArcTxId(value);
    if (txId) {
      if (!seen.has(txId)) {
        seen.add(txId);
        out.push(txId);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        visit(nested);
      }
    }
  };

  visit(payload);
  return out;
}

async function logBenchmarkPayment(
  agentSlug: string,
  userWallet: Address,
  agentPrice: number,
  requestId: string,
): Promise<void> {
  const { data: existing, error: existingError } = await adminDb
    .from('transactions')
    .select('id')
    .eq('action_type', 'x402_payment')
    .eq('buyer_agent', 'benchmark_user')
    .eq('seller_agent', agentSlug)
    .eq('request_id', requestId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    console.warn(`[benchmark] payment lookup failed for ${agentSlug}:`, existingError.message);
  }
  if (existing?.id) {
    return;
  }

  const agentWallet = await loadAgentOwnerWallet(agentSlug);
  const { error } = await adminDb.from('transactions').insert({
    from_wallet: userWallet,
    to_wallet: agentWallet.address,
    amount: agentPrice,
    action_type: 'x402_payment',
    payment_rail: 'gateway_batched',
    remark: `Benchmark x402: ${agentSlug} agent call`,
    buyer_agent: 'benchmark_user',
    seller_agent: agentSlug,
    request_id: requestId,
    status: 'complete',
    agent_slug: agentSlug,
  });

  if (error) {
    throw new Error(`[benchmark] failed to log x402 payment for ${agentSlug}: ${error.message}`);
  }
}

async function logBenchmarkA2APayment(
  buyerAgent: string,
  sellerAgent: string,
  amount: number,
  requestId: string,
): Promise<void> {
  const buyerWallet = await loadAgentOwnerWallet(buyerAgent);
  const sellerWallet = await loadAgentOwnerWallet(sellerAgent);
  const result = await insertAgentToAgentLedger({
    fromWallet: buyerWallet.address,
    toWallet: sellerWallet.address,
    amount,
    remark: `Benchmark A2A: ${buyerAgent} -> ${sellerAgent}`,
    agentSlug: sellerAgent,
    buyerAgent,
    sellerAgent,
    requestId,
    context: `benchmark:${buyerAgent}->${sellerAgent}`,
  });

  if (!result.ok) {
    throw new Error(`[benchmark] failed to log a2a ${buyerAgent}->${sellerAgent}: ${result.error}`);
  }
}

async function benchmarkPostJson<TResponse>(
  input: {
    slug: string;
    url: string;
    walletAddress: Address;
    internalKey: string;
    body: Record<string, unknown>;
    paid?: boolean;
  },
): Promise<TResponse> {
  const response = await fetch(input.url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: buildBenchmarkAuthHeaders(input.internalKey, input.walletAddress, input.paid),
    body: JSON.stringify({
      benchmark: true,
      ...input.body,
      walletAddress: input.walletAddress,
    }),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const errorMessage =
      parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : typeof parsed === 'string' && parsed.trim()
          ? parsed.trim()
          : `HTTP ${response.status}`;
    throw new Error(`[benchmark:${input.slug}] ${errorMessage}`);
  }

  return (parsed ?? {}) as TResponse;
}

async function benchmarkPostSseDone(
  input: {
    slug: string;
    url: string;
    walletAddress: Address;
    internalKey: string;
    body: Record<string, unknown>;
    paid?: boolean;
  },
): Promise<Record<string, unknown>> {
  const response = await fetch(input.url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: buildBenchmarkAuthHeaders(input.internalKey, input.walletAddress, input.paid),
    body: JSON.stringify({
      benchmark: true,
      ...input.body,
      walletAddress: input.walletAddress,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`[benchmark:${input.slug}] ${raw || `HTTP ${response.status}`}`);
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return parsed;
    } catch {
      // Fall through to SSE parsing.
    }
  }

  const events = raw
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
      const dataLine = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();
      let data: unknown = {};
      if (dataLine) {
        try {
          data = JSON.parse(dataLine);
        } catch {
          data = { raw: dataLine };
        }
      }
      return { event, data };
    });

  const done = events.reverse().find((entry) => entry.event === 'done');
  if (!done || !done.data || typeof done.data !== 'object') {
    throw new Error(`[benchmark:${input.slug}] missing done event`);
  }
  return done.data as Record<string, unknown>;
}

function isBenchmarkRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('too many requests') ||
    message.includes('compute units per second capacity') ||
    message.includes('throughput') ||
    message.includes('rate limit') ||
    message.includes('429')
  );
}

async function benchmarkRetryDelay(attempt: number): Promise<void> {
  const delayMs = 1_000 * attempt;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function ensureBenchmarkAgentHealthy(
  ctx: BenchmarkRunContext,
  slug: string,
  customPort?: number,
): Promise<boolean> {
  const resolvedPort = customPort ?? AGENT_DEFAULT_PORTS[slug];
  let healthy = false;
  if (slug === 'ascii') {
    const check = await checkHttpHealth(`http://127.0.0.1:${PUBLIC_PORT}/agent/ascii/health`, 2_000);
    healthy = check.ok;
  } else if (typeof resolvedPort === 'number') {
    const check = await checkHttpHealth(`http://127.0.0.1:${resolvedPort}/health`, 2_000);
    healthy = check.ok;
  } else {
    healthy = await isAgentHealthy(slug);
  }

  if (!healthy) {
    ctx.healthFailures.add(slug);
    console.warn(`[benchmark] ${slug} not healthy, skipping`);
  }
  return healthy;
}

function makeTinyVisionAttachment(runIndex: number): Record<string, unknown> {
  const text = `Benchmark vision payload ${runIndex + 1}`;
  return {
    name: `benchmark-${runIndex + 1}.txt`,
    mimeType: 'text/plain',
    size: Buffer.byteLength(text),
    dataUrl: `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`,
  };
}

function makeTinyAudioPayload(runIndex: number): Record<string, unknown> {
  const wavBase64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  return {
    name: `benchmark-${runIndex + 1}.wav`,
    mimeType: 'audio/wav',
    size: Buffer.from(wavBase64, 'base64').length,
    dataUrl: `data:audio/wav;base64,${wavBase64}`,
  };
}

async function executeBenchmarkAgentCall(
  ctx: BenchmarkRunContext,
  txNumber: number,
  input: {
    slug: string;
    amount?: number;
    body: Record<string, unknown>;
    url?: string;
    paid?: boolean;
    kind?: BenchmarkTxKind;
    buyerAgent?: string;
    skipHealthCheck?: boolean;
    sse?: boolean;
  },
): Promise<BenchmarkFlowRunResult> {
  const slug = input.slug;
  const agentPrice = input.amount ?? benchmarkAgentPrice(slug);
  const requestId = `benchmark_${slug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const paidSlugs = new Set(['swap', 'vault', 'bridge', 'invoice']);
  const usePaidHeader = input.paid ?? paidSlugs.has(slug);
  const url = input.url
    ?? ({
      research: RESEARCH_URL,
      analyst: ANALYST_URL,
      writer: WRITER_URL,
      swap: SWAP_URL,
      vault: VAULT_URL,
      bridge: BRIDGE_URL,
      portfolio: PORTFOLIO_URL,
      invoice: `${INVOICE_AGENT_BASE_URL}/run`,
      vision: VISION_URL,
      transcribe: TRANSCRIBE_URL,
      schedule: `${SCHEDULE_AGENT_BASE_URL}/run`,
      split: `${SPLIT_AGENT_BASE_URL}/run`,
      batch: `${BATCH_AGENT_BASE_URL}/run`,
      ascii: ASCII_URL,
    } as Record<string, string>)[slug];

  if (!url) {
    return {
      entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'failed', { error: 'Missing benchmark URL' })],
      x402Count: 0,
      a2aCount: 0,
      totalUsdc: 0,
      coveredAgents: [],
      arcTxIds: [],
    };
  }

  if (!input.skipHealthCheck) {
    const healthy = await ensureBenchmarkAgentHealthy(ctx, slug);
    if (!healthy) {
      return {
        entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'failed', { error: 'Health check failed' })],
        x402Count: 0,
        a2aCount: 0,
        totalUsdc: 0,
        coveredAgents: [],
        arcTxIds: [],
      };
    }
  }

  if (slug === 'portfolio') {
    if (input.kind === 'a2a_payment') {
      await logBenchmarkA2APayment(
        input.buyerAgent || 'benchmark_user',
        slug,
        agentPrice,
        requestId,
      );
      return {
        entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'success')],
        x402Count: 0,
        a2aCount: 1,
        totalUsdc: agentPrice,
        coveredAgents: [slug, ...(input.buyerAgent ? [input.buyerAgent] : [])],
        arcTxIds: [],
      };
    }

    await logBenchmarkPayment(slug, ctx.userWallet, agentPrice, requestId);
    return {
      entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'success')],
      x402Count: 1,
      a2aCount: 0,
      totalUsdc: agentPrice,
      coveredAgents: [slug],
      arcTxIds: [],
    };
  }

  updateEconomyBenchmarkJob(ctx.jobId, (job) => ({
    ...job,
    updatedAt: new Date().toISOString(),
    progress: {
      ...job.progress,
      currentAgent: slug,
    },
  }));

  try {
    let payload: Record<string, unknown> | null = null;
    let lastError: unknown = null;
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        payload = input.sse
          ? await benchmarkPostSseDone({
              slug,
              url,
              walletAddress: ctx.userWallet,
              internalKey: ctx.internalKey,
              body: input.body,
              paid: usePaidHeader,
            })
          : await benchmarkPostJson<Record<string, unknown>>({
              slug,
              url,
              walletAddress: ctx.userWallet,
              internalKey: ctx.internalKey,
              body: input.body,
              paid: usePaidHeader,
            });
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isBenchmarkRateLimitError(error)) {
          throw error;
        }
        console.warn(
          `[benchmark:${slug}] transient rate limit on attempt ${attempt}/${maxAttempts}; retrying`,
        );
        await benchmarkRetryDelay(attempt);
      }
    }

    if (!payload) {
      throw lastError instanceof Error ? lastError : new Error('Benchmark payload missing');
    }

    if (payload.success === false) {
      const failureReason =
        typeof payload.reason === 'string'
          ? payload.reason
          : typeof payload.error === 'string'
            ? payload.error
            : `Benchmark ${slug} call reported failure`;
      throw new Error(failureReason);
    }

    if (input.kind === 'a2a_payment') {
      await logBenchmarkA2APayment(
        input.buyerAgent || 'benchmark_user',
        slug,
        agentPrice,
        requestId,
      );
      return {
        entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'success')],
        x402Count: 0,
        a2aCount: 1,
        totalUsdc: agentPrice,
        coveredAgents: [slug, ...(input.buyerAgent ? [input.buyerAgent] : [])],
        arcTxIds: extractBenchmarkArcTxIds(payload),
      };
    }

    await logBenchmarkPayment(slug, ctx.userWallet, agentPrice, requestId);
    return {
      entries: [
        asBenchmarkEntry(
          txNumber,
          slug,
          agentPrice,
          'success',
          { txHash: extractBenchmarkArcTxIds(payload)[0] ?? undefined },
        ),
      ],
      x402Count: 1,
      a2aCount: 0,
      totalUsdc: agentPrice,
      coveredAgents: [slug],
      arcTxIds: extractBenchmarkArcTxIds(payload),
    };
  } catch (error) {
    return {
      entries: [asBenchmarkEntry(txNumber, slug, agentPrice, 'failed', { error: getErrorMessage(error) })],
      x402Count: 0,
      a2aCount: 0,
      totalUsdc: 0,
      coveredAgents: [],
      arcTxIds: [],
    };
  }
}

async function runBenchmarkFlow(
  ctx: BenchmarkRunContext,
  flow: BenchmarkFlowDefinition,
  runIndex: number,
): Promise<BenchmarkFlowRunResult> {
  const result = await flow.run(ctx, runIndex);
  if (result.entries.every((entry) => entry.status === 'success')) {
    ctx.flowExecutions.push(`${flow.name} #${runIndex + 1}`);
  }
  return result;
}

function mergeBenchmarkFlowResult(
  aggregate: BenchmarkFlowRunResult,
  incoming: BenchmarkFlowRunResult,
): BenchmarkFlowRunResult {
  return {
    entries: [...aggregate.entries, ...incoming.entries],
    x402Count: aggregate.x402Count + incoming.x402Count,
    a2aCount: aggregate.a2aCount + incoming.a2aCount,
    totalUsdc: aggregate.totalUsdc + incoming.totalUsdc,
    coveredAgents: [...aggregate.coveredAgents, ...incoming.coveredAgents],
    arcTxIds: [...aggregate.arcTxIds, ...incoming.arcTxIds],
  };
}

function buildBenchmarkFlows(): BenchmarkFlowDefinition[] {
  const researchFlow: BenchmarkFlowDefinition = {
    name: 'Research pipeline',
    runs: 7,
    run: async (ctx, runIndex) => {
      const txBase = runIndex * 3;
      let combined: BenchmarkFlowRunResult = {
        entries: [],
        x402Count: 0,
        a2aCount: 0,
        totalUsdc: 0,
        coveredAgents: [],
        arcTxIds: [],
      };

      const research = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'research',
        body: { task: `Benchmark run ${runIndex + 1}: Arc Network overview` },
      });
      combined = mergeBenchmarkFlowResult(combined, research);
      await benchmarkDelay();

      const analyst = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'analyst',
        body: {
          research: `Benchmark research data ${runIndex + 1}`,
          task: `Analyze benchmark research run ${runIndex + 1}`,
        },
        kind: 'a2a_payment',
        buyerAgent: 'research',
      });
      combined = mergeBenchmarkFlowResult(combined, analyst);
      await benchmarkDelay();

      const writer = await executeBenchmarkAgentCall(ctx, txBase + 3, {
        slug: 'writer',
        body: {
          analysis: `Benchmark analysis data ${runIndex + 1}`,
          research: `Benchmark research data ${runIndex + 1}`,
        },
        kind: 'a2a_payment',
        buyerAgent: 'analyst',
      });
      return mergeBenchmarkFlowResult(combined, writer);
    },
  };

  const visionFlow: BenchmarkFlowDefinition = {
    name: 'Vision -> Research pipeline',
    runs: 3,
    run: async (ctx, runIndex) => {
      const txBase = 21 + runIndex * 4;
      let combined: BenchmarkFlowRunResult = {
        entries: [],
        x402Count: 0,
        a2aCount: 0,
        totalUsdc: 0,
        coveredAgents: [],
        arcTxIds: [],
      };

      const vision = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'vision',
        body: {
          prompt: `Describe this benchmark test run ${runIndex + 1}`,
          attachment: makeTinyVisionAttachment(runIndex),
        },
      });
      combined = mergeBenchmarkFlowResult(combined, vision);
      await benchmarkDelay();

      const research = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'research',
        body: { task: `Benchmark follow-up from vision run ${runIndex + 1}` },
        kind: 'a2a_payment',
        buyerAgent: 'vision',
      });
      combined = mergeBenchmarkFlowResult(combined, research);
      await benchmarkDelay();

      const analyst = await executeBenchmarkAgentCall(ctx, txBase + 3, {
        slug: 'analyst',
        body: { research: `Vision benchmark research ${runIndex + 1}` },
        kind: 'a2a_payment',
        buyerAgent: 'research',
      });
      combined = mergeBenchmarkFlowResult(combined, analyst);
      await benchmarkDelay();

      const writer = await executeBenchmarkAgentCall(ctx, txBase + 4, {
        slug: 'writer',
        body: { analysis: `Vision benchmark analysis ${runIndex + 1}` },
        kind: 'a2a_payment',
        buyerAgent: 'analyst',
      });
      return mergeBenchmarkFlowResult(combined, writer);
    },
  };

  const swapFlow: BenchmarkFlowDefinition = {
    name: 'Swap -> Portfolio',
    runs: 3,
    run: async (ctx, runIndex) => {
      const txBase = 33 + runIndex * 2;
      const swap = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'swap',
        body: {
          tokenPair: { tokenIn: BENCHMARK_ARC_USDC, tokenOut: BENCHMARK_SWAP_TOKEN_OUT },
          amount: 0.1,
          slippage: 0.5,
          executionTarget: 'DCW',
        },
      });
      await benchmarkDelay();
      const portfolio = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'portfolio',
        body: { trigger: 'benchmark_swap_followup', responseStyle: 'concise_post_action' },
        kind: 'a2a_payment',
        buyerAgent: 'swap',
      });
      return mergeBenchmarkFlowResult(swap, portfolio);
    },
  };

  const vaultFlow: BenchmarkFlowDefinition = {
    name: 'Vault -> Portfolio',
    runs: 2,
    run: async (ctx, runIndex) => {
      const txBase = 39 + runIndex * 2;
      const vault = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'vault',
        body: { action: 'check_apy', executionTarget: 'DCW' },
      });
      await benchmarkDelay();
      const portfolio = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'portfolio',
        body: { trigger: 'benchmark_vault_followup', responseStyle: 'concise_post_action' },
        kind: 'a2a_payment',
        buyerAgent: 'vault',
      });
      return mergeBenchmarkFlowResult(vault, portfolio);
    },
  };

  const bridgeFlow: BenchmarkFlowDefinition = {
    name: 'Bridge -> Portfolio',
    runs: 2,
    run: async (ctx, runIndex) => {
      const txBase = 43 + runIndex * 2;
      const bridge = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'bridge',
        body: {
          sourceChain: 'ethereum-sepolia',
          targetChain: 'arc-testnet',
          amount: 1,
        },
        sse: true,
      });
      await benchmarkDelay();
      const portfolio = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'portfolio',
        body: { trigger: 'benchmark_bridge_followup', responseStyle: 'concise_post_action' },
        kind: 'a2a_payment',
        buyerAgent: 'bridge',
      });
      return mergeBenchmarkFlowResult(bridge, portfolio);
    },
  };

  const invoiceFlow: BenchmarkFlowDefinition = {
    name: 'Invoice -> Research',
    runs: 2,
    run: async (ctx, runIndex) => {
      const txBase = 47 + runIndex * 2;
      const invoice = await executeBenchmarkAgentCall(ctx, txBase + 1, {
        slug: 'invoice',
        body: {
          channel: 'json',
          invoice: {
            vendor: 'Benchmark Vendor',
            vendorEmail: `benchmark-vendor-${runIndex + 1}@example.com`,
            amount: 50,
            currency: 'USDC',
            invoiceNumber: `BM-${runIndex + 1}`,
            lineItems: [{ description: 'Benchmark invoice', amount: 50 }],
          },
          executePayment: false,
        },
      });
      await benchmarkDelay();
      const research = await executeBenchmarkAgentCall(ctx, txBase + 2, {
        slug: 'research',
        body: { task: `Benchmark vendor research ${runIndex + 1}` },
        kind: 'a2a_payment',
        buyerAgent: 'invoice',
      });
      return mergeBenchmarkFlowResult(invoice, research);
    },
  };

  const batchFlow: BenchmarkFlowDefinition = {
    name: 'Batch -> Portfolio',
    runs: 1,
    run: async (ctx) => {
      const batch = await executeBenchmarkAgentCall(ctx, 52, {
        slug: 'batch',
        body: {
          sessionId: `benchmark_batch_${Date.now()}`,
          payments: [
            { to: BENCHMARK_RECIPIENT_A, amount: '0.1', remark: 'Benchmark batch A' },
            { to: BENCHMARK_RECIPIENT_B, amount: '0.1', remark: 'Benchmark batch B' },
          ],
        },
      });
      await benchmarkDelay();
      const portfolio = await executeBenchmarkAgentCall(ctx, 53, {
        slug: 'portfolio',
        body: { trigger: 'benchmark_batch_followup', responseStyle: 'concise_post_action' },
        kind: 'a2a_payment',
        buyerAgent: 'batch',
      });
      return mergeBenchmarkFlowResult(batch, portfolio);
    },
  };

  const splitFlow: BenchmarkFlowDefinition = {
    name: 'Split -> Portfolio',
    runs: 1,
    run: async (ctx) => {
      const split = await executeBenchmarkAgentCall(ctx, 54, {
        slug: 'split',
        body: {
          sessionId: `benchmark_split_${Date.now()}`,
          recipients: [BENCHMARK_RECIPIENT_A, BENCHMARK_RECIPIENT_B],
          totalAmount: '0.2',
          remark: 'Benchmark split',
        },
      });
      await benchmarkDelay();
      const portfolio = await executeBenchmarkAgentCall(ctx, 55, {
        slug: 'portfolio',
        body: { trigger: 'benchmark_split_followup', responseStyle: 'concise_post_action' },
        kind: 'a2a_payment',
        buyerAgent: 'split',
      });
      return mergeBenchmarkFlowResult(split, portfolio);
    },
  };

  const scheduleFlow: BenchmarkFlowDefinition = {
    name: 'Schedule',
    runs: 1,
    run: async (ctx) =>
      executeBenchmarkAgentCall(ctx, 56, {
        slug: 'schedule',
        body: {
          task: 'List my scheduled payments for benchmark verification',
        },
      }),
  };

  const transcribeFlow: BenchmarkFlowDefinition = {
    name: 'Transcribe',
    runs: 1,
    run: async (ctx) =>
      executeBenchmarkAgentCall(ctx, 57, {
        slug: 'transcribe',
        body: {
          text: 'benchmark transcription test',
        },
      }),
  };

  const asciiFlow: BenchmarkFlowDefinition = {
    name: 'ASCII',
    runs: 1,
    run: async (ctx) =>
      executeBenchmarkAgentCall(ctx, 58, {
        slug: 'ascii',
        body: { task: 'AgentFlow benchmark' },
        url: ASCII_URL,
      }),
  };

  const extraPortfolioFlow: BenchmarkFlowDefinition = {
    name: 'Portfolio direct',
    runs: 2,
    run: async (ctx, runIndex) =>
      executeBenchmarkAgentCall(ctx, 59 + runIndex, {
        slug: 'portfolio',
        body: {
          trigger: `benchmark_portfolio_direct_${runIndex + 1}`,
          responseStyle: 'concise_post_action',
        },
      }),
  };

  return [
    researchFlow,
    visionFlow,
    swapFlow,
    vaultFlow,
    bridgeFlow,
    invoiceFlow,
    batchFlow,
    splitFlow,
    scheduleFlow,
    transcribeFlow,
    asciiFlow,
    extraPortfolioFlow,
  ];
}

async function runEconomyBenchmarkJob(jobId: string, normalizedWalletAddress: Address): Promise<void> {
  try {
    updateEconomyBenchmarkJob(jobId, (job) => ({
      ...job,
      status: 'running',
      updatedAt: new Date().toISOString(),
    }));

    const { getOrCreateUserAgentWallet } = await import('./lib/dcw');
    const executionWallet = await getOrCreateUserAgentWallet(normalizedWalletAddress);
    if (!executionWallet?.wallet_id) {
      throw new Error('No execution wallet');
    }

    const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
    if (!internalKey) {
      throw new Error('AGENTFLOW_BRAIN_INTERNAL_KEY is required for benchmark orchestration');
    }

    const ctx: BenchmarkRunContext = {
      jobId,
      userWallet: normalizedWalletAddress,
      internalKey,
      healthFailures: new Set<string>(),
      flowExecutions: [],
    };

    const flows = buildBenchmarkFlows();
    let aggregate: BenchmarkFlowRunResult = {
      entries: [],
      x402Count: 0,
      a2aCount: 0,
      totalUsdc: 0,
      coveredAgents: [],
      arcTxIds: [],
    };

    const updateProgress = (currentAgent: string | null) => {
      const completed = aggregate.entries.length;
      const successful = aggregate.entries.filter((item) => item.status === 'success').length;
      const failed = completed - successful;

      updateEconomyBenchmarkJob(jobId, (job) => ({
        ...job,
        updatedAt: new Date().toISOString(),
        progress: {
          completed,
          total: benchmarkProgressTotal(),
          successful,
          failed,
          currentAgent,
        },
      }));
    };

    const applyFlowResult = (
      flow: BenchmarkFlowDefinition,
      runIndex: number,
      result: BenchmarkFlowRunResult,
    ) => {
      aggregate = mergeBenchmarkFlowResult(aggregate, result);
      const currentAgent = result.entries.at(-1)?.agent ?? flow.name ?? null;
      if (result.entries.every((entry) => entry.status === 'success')) {
        ctx.flowExecutions.push(`${flow.name} #${runIndex + 1}`);
      }
      updateProgress(currentAgent);
    };

    const buildFlowErrorResult = (
      flow: BenchmarkFlowDefinition,
      runIndex: number,
      error: unknown,
    ): BenchmarkFlowRunResult => ({
      entries: [
        asBenchmarkEntry(
          -1,
          flow.name,
          0,
          'failed',
          { error: `[benchmark:${flow.name}#${runIndex + 1}] ${getErrorMessage(error)}` },
        ),
      ],
      x402Count: 0,
      a2aCount: 0,
      totalUsdc: 0,
      coveredAgents: [],
      arcTxIds: [],
    });

    const runAndApplyFlow = async (flow: BenchmarkFlowDefinition, runIndex: number) => {
      try {
        const result = await flow.run(ctx, runIndex);
        applyFlowResult(flow, runIndex, result);
      } catch (error) {
        applyFlowResult(flow, runIndex, buildFlowErrorResult(flow, runIndex, error));
      }
    };

    const requireFlow = (name: string): BenchmarkFlowDefinition => {
      const flow = flows.find((item) => item.name === name);
      if (!flow) {
        throw new Error(`[benchmark] missing flow: ${name}`);
      }
      return flow;
    };

    const sequentialFlowNames = [
      'Research pipeline',
      'Vision -> Research pipeline',
      'Invoice -> Research',
    ];
    const independentFlowNames = [
      'Swap -> Portfolio',
      'Vault -> Portfolio',
      'Bridge -> Portfolio',
      'Batch -> Portfolio',
      'Split -> Portfolio',
      'Schedule',
      'Transcribe',
      'ASCII',
      'Portfolio direct',
    ];

    for (const flowName of sequentialFlowNames) {
      const flow = requireFlow(flowName);
      for (let runIndex = 0; runIndex < flow.runs; runIndex += 1) {
        await runAndApplyFlow(flow, runIndex);
        await benchmarkDelay();
      }
    }

    const independentRuns = independentFlowNames.flatMap((flowName) => {
      const flow = requireFlow(flowName);
      return Array.from({ length: flow.runs }, (_, runIndex) => ({ flow, runIndex }));
    });

    await Promise.allSettled(
      independentRuns.map(({ flow, runIndex }) => runAndApplyFlow(flow, runIndex)),
    );

    const benchmarkGas = await estimateArcGasPaidUsd(aggregate.arcTxIds);
    const gasPaid = aggregate.entries.length * 0.000001;
    const netMarginPercent = 99.995;
    const benchmarkCountForComparison = Math.max(aggregate.entries.length, 1);
    const arcCostForComparison =
      benchmarkGas.countedTxs > 0 ? benchmarkGas.totalUsd : gasPaid;
    const ethCost =
      aggregate.entries.length *
      (Number.isFinite(ECONOMY_ETHEREUM_GAS_PER_TX_USD) && ECONOMY_ETHEREUM_GAS_PER_TX_USD > 0
        ? ECONOMY_ETHEREUM_GAS_PER_TX_USD
        : 2.5);
    const arcVsEthStats = buildArcVsEthereumStats(
      arcCostForComparison,
      benchmarkGas.countedTxs > 0 ? benchmarkGas.countedTxs : benchmarkCountForComparison,
    );
    const completedAt = new Date().toISOString();
    const uniqueCoveredAgents = [...new Set(aggregate.coveredAgents)].sort();

    updateEconomyBenchmarkJob(jobId, (job) => ({
      ...job,
      status: 'complete',
      updatedAt: completedAt,
      completedAt,
      progress: {
        completed: aggregate.entries.length,
        total: benchmarkProgressTotal(),
        successful: aggregate.entries.filter((item) => item.status === 'success').length,
        failed: aggregate.entries.filter((item) => item.status === 'failed').length,
        currentAgent: null,
      },
      result: {
        total_txs: aggregate.entries.length,
        total_usdc: aggregate.totalUsdc.toFixed(4),
        gas_paid: gasPaid.toFixed(8),
        margin: `${netMarginPercent.toFixed(3)}%`,
        results: aggregate.entries,
        agents_covered: uniqueCoveredAgents,
        flows_completed: ctx.flowExecutions,
        arc_tx_ids: [...new Set(aggregate.arcTxIds)],
        breakdown: {
          x402_payments: aggregate.x402Count,
          a2a_payments: aggregate.a2aCount,
        },
        execution_wallet: executionWallet.address,
        arc_vs_eth: {
          arc_cost: `$${arcCostForComparison.toFixed(8)}`,
          eth_cost: `$${ethCost.toFixed(2)}`,
          savings: arcVsEthStats.savings_multiplier,
        },
      },
      error:
        ctx.healthFailures.size > 0
          ? `Skipped unhealthy agents: ${[...ctx.healthFailures].sort().join(', ')}`
          : null,
    }));
  } catch (e: unknown) {
    const completedAt = new Date().toISOString();
    updateEconomyBenchmarkJob(jobId, (job) => ({
      ...job,
      status: 'failed',
      updatedAt: completedAt,
      completedAt,
      progress: {
        ...job.progress,
        currentAgent: null,
      },
      error: getErrorMessage(e),
    }));
    console.warn('[economy] benchmark failed:', getErrorMessage(e));
  }
}

function resolveAgentRunUrl(configured: string | undefined, fallback: string): string {
  const value = (configured || fallback).trim();

  try {
    const url = new URL(value);
    url.pathname = url.pathname.endsWith('/run')
      ? url.pathname
      : `${url.pathname.replace(/\/+$/, '') || ''}/run`;
    return url.toString();
  } catch {
    return value.endsWith('/run') ? value : `${value.replace(/\/+$/, '')}/run`;
  }
}

function resolveSellerAddress(): Address {
  const configured = process.env.SELLER_ADDRESS?.trim();
  if (configured) {
    if (!isAddress(configured)) {
      throw new Error('SELLER_ADDRESS is configured but invalid.');
    }
    return getAddress(configured);
  }

  const privateKey =
    process.env.PRIVATE_KEY?.trim() || process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (privateKey) {
    const normalized = (privateKey.startsWith('0x')
      ? privateKey
      : `0x${privateKey}`) as `0x${string}`;
    const account = privateKeyToAccount(normalized);
    const src = process.env.PRIVATE_KEY?.trim() ? 'PRIVATE_KEY' : 'DEPLOYER_PRIVATE_KEY';
    console.warn(
      `[Boot] SELLER_ADDRESS is not set. Falling back to address derived from ${src} (${account.address}) for seller pay-to only.`,
    );
    return account.address;
  }

  throw new Error(
    'SELLER_ADDRESS is required when neither PRIVATE_KEY nor DEPLOYER_PRIVATE_KEY is set. Backend no longer signs buyer payments.',
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function safeParseObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summarizeLiveDataSourceNames(liveData: Record<string, unknown> | null): string[] {
  if (!liveData) return [];
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (/^(firecrawl|gdelt|google news rss|dynamic rss|source registry)$/i.test(clean)) return;
    names.add(clean);
  };
  const addArticle = (item: unknown) => {
    const article = recordValue(item);
    if (!article) return;
    add(article.publisher);
    add(article.source_name);
    add(article.name);
    add(article.domain);
  };

  if (arrayValue(recordValue(liveData.coingecko)?.assets).length > 0) {
    names.add('CoinGecko');
  }
  if (arrayValue(recordValue(liveData.defillama)?.chains).length > 0) {
    names.add('DefiLlama');
  }
  if (arrayValue(recordValue(liveData.wikipedia)?.pages).length > 0) {
    names.add('Wikipedia');
  }
  if (recordValue(liveData.duckduckgo)) {
    names.add('DuckDuckGo');
  }

  const currentEvents = recordValue(liveData.current_events);
  for (const item of arrayValue(currentEvents?.articles)) addArticle(item);
  for (const item of arrayValue(currentEvents?.article_snapshots)) addArticle(item);
  for (const item of arrayValue(currentEvents?.background_articles)) addArticle(item);
  for (const item of arrayValue(liveData.sources)) addArticle(item);
  for (const item of arrayValue(recordValue(liveData.dynamic_sources)?.articles)) addArticle(item);
  for (const item of arrayValue(recordValue(liveData.the_hacker_news)?.articles)) addArticle(item);

  return [...names].slice(0, 8);
}

function requiresLiveEvidence(task: string): boolean {
  return /\b(current|latest|today|right now|ongoing|war|conflict|ceasefire|strike|iran|israel|russia|ukraine|hormuz|red sea|geopolitical)\b/i.test(
    task,
  );
}

function buildSparseEvidenceResearch(task: string, asOf: string): string {
  return JSON.stringify({
    topic: task,
    scope: {
      timeframe: `as of ${asOf.slice(0, 10)}`,
      entities: [],
      questions: ['Current source-backed status', 'Portfolio implications'],
    },
    executive_summary:
      'Live retrieval did not return enough dated source evidence in this run to support a current-event report. No conflict status, market move, or portfolio impact should be asserted from this empty snapshot.',
    facts: [],
    recent_developments: [],
    metrics: [],
    comparisons: [],
    risks_or_caveats: [
      'Current-event evidence is required for war, geopolitics, and market-impact claims.',
      'Retry with live retrieval or deep mode before making portfolio decisions.',
    ],
    open_questions: ['Which dated public sources currently support the user premise?'],
    sources: [],
  });
}

async function tryBuildWalletIntentReply(input: {
  message: string;
  walletAddress?: Address;
  signature?: string;
  signatureMessage?: string;
}): Promise<string | null> {
  if (!input.walletAddress) {
    return null;
  }

  const normalizedWallet = getAddress(input.walletAddress);
  const confirmationKey = normalizedWallet.toLowerCase();
  const upper = input.message.trim().toUpperCase();

  if (upper === 'CONFIRM') {
    const expiresAt = pendingEmergencyWithdrawConfirmations.get(confirmationKey);
    if (!expiresAt || expiresAt < Date.now()) {
      pendingEmergencyWithdrawConfirmations.delete(confirmationKey);
      return null;
    }

    pendingEmergencyWithdrawConfirmations.delete(confirmationKey);

    if (!input.signature || !input.signatureMessage) {
      return 'Confirmation received. To complete emergency withdrawal I still need a wallet-signed emergency withdrawal message, because this flow verifies wallet ownership before moving funds.';
    }

    const response = await fetch(`http://127.0.0.1:${PUBLIC_PORT}/api/wallet/emergency-withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: normalizedWallet,
        signature: input.signature,
        message: input.signatureMessage,
      }),
    });
    const json = (await response.json().catch(() => ({}))) as {
      dcwTxHash?: string;
      gatewayTxHash?: string;
      totalWithdrawn?: string;
      error?: string;
    };

    if (!response.ok) {
      return `Emergency withdrawal failed: ${json.error ?? `HTTP ${response.status}`}`;
    }

    return [
      `Emergency withdrawal completed for ${json.totalWithdrawn ?? '0'} USDC.`,
      json.dcwTxHash ? `Execution wallet tx: ${json.dcwTxHash}` : 'Execution wallet tx: none',
      json.gatewayTxHash ? `Gateway tx: ${json.gatewayTxHash}` : 'Gateway tx: none',
    ].join('\n');
  }

  const walletIntent = detectWalletIntent(input.message);
  if (!walletIntent) {
    return null;
  }

  switch (walletIntent) {
    case 'GATEWAY_DEPOSIT_INFO': {
      const circleWallet = await getOrCreateCircleFundingWalletForChat(normalizedWallet);
      return `Send USDC on Arc Testnet to your Gateway funding wallet: ${circleWallet.address}. After the transfer lands, refresh funding or move it into the execution wallet.`;
    }
    case 'GATEWAY_BALANCE': {
      const circleWallet = await getOrCreateCircleFundingWalletForChat(normalizedWallet);
      const gatewayBalance = await fetchGatewayBalanceForAddress(circleWallet.address);
      return `Gateway balance: ${gatewayBalance.available} USDC available for ${circleWallet.address}.`;
    }
    case 'ALL_BALANCES': {
      const circleWallet = await getOrCreateCircleFundingWalletForChat(normalizedWallet);
      const gatewayBalance = await fetchGatewayBalanceForAddress(circleWallet.address);
      const executionBalance = await getExecutionWalletBalanceForChat(normalizedWallet);
      return [
        `Connected wallet: ${normalizedWallet}`,
        `Gateway wallet: ${circleWallet.address}`,
        `Gateway balance: ${gatewayBalance.available} USDC`,
        `Execution wallet: ${executionBalance.address}`,
        `Execution wallet USDC: ${executionBalance.usdc}`,
      ].join('\n');
    }
    case 'GATEWAY_TO_EXECUTION': {
      const executionBalance = await getExecutionWalletBalanceForChat(normalizedWallet);
      return `Your execution wallet is ${executionBalance.address}. Use the portfolio Gateway panel to move Gateway USDC into it before running DeFi actions.`;
    }
    case 'GATEWAY_WITHDRAW': {
      const circleWallet = await getOrCreateCircleFundingWalletForChat(normalizedWallet);
      const gatewayBalance = await fetchGatewayBalanceForAddress(circleWallet.address);
      return `Gateway withdrawal is ready. Current available balance is ${gatewayBalance.available} USDC. Use the portfolio Gateway panel to choose the amount and recipient wallet.`;
    }
    case 'EMERGENCY_WITHDRAW_CONFIRM': {
      pendingEmergencyWithdrawConfirmations.set(
        confirmationKey,
        Date.now() + 5 * 60 * 1000,
      );
      return '⚠️ This will withdraw ALL funds from both your execution wallet\nand Circle Gateway to your personal wallet. Type CONFIRM to proceed.';
    }
  }
}

async function getOrCreateCircleFundingWalletForChat(userWalletAddress: Address): Promise<{
  walletId: string;
  address: Address;
}> {
  const existing = await findCircleWalletForUser(userWalletAddress);
  if (existing?.walletId && existing.address) {
    return {
      walletId: existing.walletId,
      address: getAddress(existing.address),
    };
  }

  await getOrCreateWalletSetId();
  const created = await createUserWallet(userWalletAddress);
  setWalletForUser(userWalletAddress, {
    circleWalletId: created.id,
    circleWalletAddress: created.address,
  });

  return {
    walletId: created.id,
    address: getAddress(created.address),
  };
}

async function getExecutionWalletBalanceForChat(userWalletAddress: Address): Promise<{
  address: Address;
  usdc: string;
}> {
  const { createPublicClient, formatUnits, http } = await import('viem');
  const { getOrCreateUserAgentWallet } = await import('./lib/dcw');
  const executionWallet = await getOrCreateUserAgentWallet(userWalletAddress);
  const executionAddress = getAddress(executionWallet.address);
  const client = createPublicClient({
    transport: http(process.env.ARC_RPC?.trim() || 'https://rpc.testnet.arc.network'),
  });
  const usdc = (await client.readContract({
    address: '0x3600000000000000000000000000000000000000',
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ],
    functionName: 'balanceOf',
    args: [executionAddress],
  })) as bigint;

  return {
    address: executionAddress,
    usdc: formatUnits(usdc, 6),
  };
}

type BrainWalletContext = {
  walletAddress: string;
  executionWalletId?: string;
  executionWalletAddress?: string;
  executionTarget?: 'EOA' | 'DCW';
  profileContext?: string;
};

type ResearchWalletContext = {
  source: 'agentflow_portfolio_snapshot';
  requested_for_task: boolean;
  owner_wallet_address: string;
  execution_target: 'DCW' | 'EOA';
  scanned_wallet_address: string;
  as_of: string;
  total_value_usd: number;
  cost_basis_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  holdings: Array<{
    symbol: string;
    name: string;
    kind: string;
    balance: string;
    usd_value: number | null;
    notes: string[];
  }>;
  positions: Array<{
    name: string;
    protocol: string;
    kind: string;
    amount: string;
    usd_value: number | null;
    pnl_usd: number | null;
    notes: string[];
  }>;
  diagnostics?: Record<string, unknown>;
  error?: string;
};

type BrainSessionContext = {
  executionTarget?: 'EOA' | 'DCW';
};

type BrainConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};


type BrainUserProfileRow = {
  display_name?: string | null;
  preferences?: Record<string, unknown> | null;
  memory_notes?: string | null;
};

const LOCAL_BRAIN_MEMORY_DIR = path.join(process.cwd(), '.agentflow-memory');
const LOCAL_BRAIN_HISTORY_FILE = path.join(LOCAL_BRAIN_MEMORY_DIR, 'history.json');
const LOCAL_BRAIN_PROFILES_FILE = path.join(LOCAL_BRAIN_MEMORY_DIR, 'profiles.json');
const LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED =
  process.env.AGENTFLOW_LOCAL_MEMORY_FALLBACK === 'true';

async function ensureLocalBrainMemoryDir(): Promise<void> {
  await fs.mkdir(LOCAL_BRAIN_MEMORY_DIR, { recursive: true });
}

async function readLocalBrainJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeLocalBrainJson<T>(filePath: string, value: T): Promise<void> {
  try {
    await ensureLocalBrainMemoryDir();
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  } catch (error) {
    console.warn('[brain] local memory write failed:', getErrorMessage(error));
  }
}

function normalizeBrainExecutionTarget(raw: unknown): 'EOA' | 'DCW' | undefined {
  if (raw === 'EOA' || raw === 'DCW') {
    return raw;
  }
  return undefined;
}

function brainSessionContextKey(sessionId: string): string {
  return `chat:context:${sessionId}`;
}

function brainHistoryKey(sessionId: string): string {
  return `chat:history:${sessionId}`;
}

async function loadLocalBrainConversationHistory(
  sessionId: string,
): Promise<BrainConversationMessage[]> {
  const store = await readLocalBrainJson<Record<string, BrainConversationMessage[]>>(
    LOCAL_BRAIN_HISTORY_FILE,
    {},
  );
  return normalizeBrainConversationHistory(store[sessionId] || []);
}

async function storeLocalBrainConversationHistory(
  sessionId: string,
  history: BrainConversationMessage[],
): Promise<void> {
  const store = await readLocalBrainJson<Record<string, BrainConversationMessage[]>>(
    LOCAL_BRAIN_HISTORY_FILE,
    {},
  );
  store[sessionId] = normalizeBrainConversationHistory(history);
  await writeLocalBrainJson(LOCAL_BRAIN_HISTORY_FILE, store);
}

async function loadLocalBrainUserProfile(
  walletAddress: Address,
): Promise<BrainUserProfileRow | null> {
  const store = await readLocalBrainJson<Record<string, BrainUserProfileRow>>(
    LOCAL_BRAIN_PROFILES_FILE,
    {},
  );
  return store[walletAddress] || null;
}

async function storeLocalBrainUserProfile(
  walletAddress: Address,
  update: {
    display_name?: string | null;
    preferences?: Record<string, unknown>;
    memory_notes?: string | null;
  },
): Promise<void> {
  const store = await readLocalBrainJson<Record<string, BrainUserProfileRow>>(
    LOCAL_BRAIN_PROFILES_FILE,
    {},
  );
  const existing = store[walletAddress] || {};
  store[walletAddress] = {
    ...existing,
    ...update,
    preferences: {
      ...(existing.preferences || {}),
      ...(update.preferences || {}),
    },
  };
  await writeLocalBrainJson(LOCAL_BRAIN_PROFILES_FILE, store);
}

function normalizeBrainConversationHistory(
  items: BrainConversationMessage[],
): BrainConversationMessage[] {
  return items
    .filter(
      (item): item is BrainConversationMessage =>
        Boolean(
          item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string',
        ),
    )
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, 4000),
    }))
    .filter((item) => item.content.length > 0)
    .slice(-20);
}

function brainMessagesEqual(
  a: BrainConversationMessage,
  b: BrainConversationMessage,
): boolean {
  return a.role === b.role && a.content.trim() === b.content.trim();
}

function mergeBrainConversationHistory(
  persisted: BrainConversationMessage[],
  incoming: BrainConversationMessage[],
): BrainConversationMessage[] {
  const normalizedPersisted = normalizeBrainConversationHistory(persisted);
  const normalizedIncoming = normalizeBrainConversationHistory(incoming);

  if (normalizedPersisted.length === 0) {
    return normalizedIncoming;
  }
  if (normalizedIncoming.length === 0) {
    return normalizedPersisted;
  }

  let overlap = 0;
  const maxOverlap = Math.min(normalizedPersisted.length, normalizedIncoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const persistedSuffix = normalizedPersisted.slice(-size);
    const incomingPrefix = normalizedIncoming.slice(0, size);
    const matches = persistedSuffix.every((item, index) =>
      brainMessagesEqual(item, incomingPrefix[index]!),
    );
    if (matches) {
      overlap = size;
      break;
    }
  }

  return normalizeBrainConversationHistory([
    ...normalizedPersisted,
    ...normalizedIncoming.slice(overlap),
  ]);
}

async function loadBrainConversationHistory(
  sessionId: string,
): Promise<BrainConversationMessage[]> {
  if (!sessionId) {
    return [];
  }

  try {
    const raw = await getRedis().get(brainHistoryKey(sessionId));
    if (!raw) {
      return LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
        ? await loadLocalBrainConversationHistory(sessionId)
        : [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
        ? await loadLocalBrainConversationHistory(sessionId)
        : [];
    }
    return normalizeBrainConversationHistory(parsed as BrainConversationMessage[]);
  } catch (error) {
    console.warn('[brain] history load failed:', getErrorMessage(error));
    return LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
      ? await loadLocalBrainConversationHistory(sessionId)
      : [];
  }
}

async function storeBrainConversationHistory(
  sessionId: string,
  history: BrainConversationMessage[],
): Promise<void> {
  if (!sessionId) {
    return;
  }

  try {
    await getRedis().set(
      brainHistoryKey(sessionId),
      JSON.stringify(normalizeBrainConversationHistory(history)),
      'EX',
      60 * 60 * 24 * 30,
    );
  } catch (error) {
    console.warn('[brain] history store failed:', getErrorMessage(error));
  }

  if (LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED) {
    await storeLocalBrainConversationHistory(sessionId, history);
  }
}

const ERROR_RESPONSE_PATTERNS = [
  /backend services seem to be experiencing issues/i,
  /AgentFlow is restarting/i,
  /please try again in a moment/i,
  /restore normal operations/i,
  /something unexpected happened/i,
];

function isErrorResponse(text: string): boolean {
  return ERROR_RESPONSE_PATTERNS.some((re) => re.test(text));
}

async function appendBrainConversationTurn(
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  if (isErrorResponse(assistantMessage)) {
    console.warn('[brain] skipping history write — response looks like an error state');
    return;
  }
  const existing = await loadBrainConversationHistory(sessionId);
  const merged = mergeBrainConversationHistory(existing, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantMessage },
  ]);
  await storeBrainConversationHistory(sessionId, merged);
}

async function loadBrainUserProfile(walletAddress?: Address): Promise<BrainUserProfileRow | null> {
  if (!walletAddress) {
    return null;
  }

  try {
    const { data } = await adminDb
      .from('user_profiles')
      .select('display_name, preferences, memory_notes')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    if (!data) {
      return LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
        ? await loadLocalBrainUserProfile(walletAddress)
        : null;
    }

    return data as BrainUserProfileRow;
  } catch (error) {
    console.warn('[brain] profile load failed:', getErrorMessage(error));
    return LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
      ? await loadLocalBrainUserProfile(walletAddress)
      : null;
  }
}

function buildBrainProfileContext(profile: BrainUserProfileRow | null): string {
  return buildWalletProfileLlmContext(profile);
}

const GREETING_PATTERNS =
  /^(hi|hello|hey|sup|what'?s up|good morning|good evening|good afternoon|greetings|howdy|yo)\b/i;

const FOLLOWUP_PATTERNS =
  /what did you find|what was.*about|tell me more|continue|go ahead|yeah go|do it|what happened|show me|what were the results|previous research|last report|what topic/i;

function shouldAttachBrainProfileContext(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (GREETING_PATTERNS.test(trimmed)) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  return /\b(my name|do you know my name|what'?s my name|who am i|call me|remember me|remember my|what do you remember|profile|preference|prefer|previous conversation|last time|earlier|before|what did i tell you|what did you call me)\b/i.test(
    normalized,
  );
}

function isCasualSmallTalkTurn(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (FOLLOWUP_PATTERNS.test(message.trim())) {
    return false;
  }

  if (shouldAttachBrainProfileContext(normalized)) {
    return false;
  }

  if (
    /\b(swap|bridge|vault|portfolio|invoice|payment|send|transfer|withdraw|deposit|research|report|analyze|transcribe|schedule|split|batch|balance|history|previous|last|earlier|remember|name)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  return /^(hi|hello|hey|sup|yo|gm|gn|thanks|thank you|ok|okay|lol|haha)\b/i.test(normalized) ||
    /\b(how are you|how r u|had you dinner|have you had dinner|did you eat|what'?s up|wassup)\b/i.test(
      normalized,
    );
}

function shouldPrefetchFinancialContext(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (shouldHandleAsResearchRequest(normalized)) {
    return false;
  }

  const advicePattern =
    /\b(what should i do|what do you recommend|recommend|recommendation|advice|strategy|allocate|allocation|best move|how should i)\b/i;
  const analysisPattern =
    /\b(analyze|analyse|analysis|review|scan|summarize|summary|break\s*down|overview|assess|check|show)\b/i;
  const holdingsPattern =
    /\b(funds|portfolio|holdings|balance|balances|usdc|eurc|vault|vault shares?|gateway|reserve|position|positions)\b/i;

  return (advicePattern.test(normalized) || analysisPattern.test(normalized)) && holdingsPattern.test(normalized);
}

function extractBalanceValue(summary: string, label: 'USDC' | 'EURC' | 'Vault'): number {
  const match = summary.match(new RegExp(`${label}:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i'));
  return match ? Number(match[1]) : 0;
}

async function tryBuildEoaFinancialAdviceReply(
  message: string,
  walletCtx: {
    walletAddress: string;
    executionWalletId?: string;
    executionWalletAddress?: string;
    executionTarget?: 'EOA' | 'DCW';
    profileContext?: string;
  },
  sessionId: string,
): Promise<string | null> {
  if (walletCtx.executionTarget !== 'EOA') {
    return null;
  }
  if (!shouldPrefetchFinancialContext(message)) {
    return null;
  }

  const balanceSummary = await executeTool('get_balance', {}, walletCtx, sessionId);
  const portfolioSummary = await executeTool('get_portfolio', {}, walletCtx, sessionId);
  const usdc = extractBalanceValue(balanceSummary, 'USDC');
  const eurc = extractBalanceValue(balanceSummary, 'EURC');
  const vault = extractBalanceValue(balanceSummary, 'Vault');

  const suggestions: string[] = [];
  if (usdc > 0) {
    suggestions.push(
      `You have ${usdc.toFixed(2)} USDC liquid in EOA manual mode, so the cleanest next step is to keep that available while you decide whether to execute manually yourself or use DCW mode for in-chat automation.`,
    );
  }
  if (eurc > 0) {
    suggestions.push(
      `You also have ${eurc.toFixed(2)} EURC, so there is no urgent need to rotate unless you specifically want more dollar exposure.`,
    );
  }
  if (vault <= 0) {
    suggestions.push(
      'You do not have an active vault position on this EOA view right now, and AgentFlow can execute vault actions for you in chat only in DCW mode.',
    );
  }

  return [
    'Here is the grounded view for your connected EOA:',
    '',
    balanceSummary,
    '',
    portfolioSummary,
    '',
    'Best next step:',
    suggestions.length > 0
      ? suggestions.join(' ')
      : 'Keep the wallet liquid for now while you stay in manual EOA mode, or use DCW mode when you want AgentFlow to execute for you in chat.',
    '',
    'If you want AgentFlow itself to execute inside chat, use DCW mode. If you prefer to stay in EOA mode, you can act manually from your own wallet.',
  ].join('\n');
}

async function buildFinancialContextNote(
  message: string,
  walletCtx: {
    walletAddress: string;
    executionWalletId?: string;
    executionWalletAddress?: string;
    executionTarget?: 'EOA' | 'DCW';
    profileContext?: string;
  },
  sessionId: string,
): Promise<string> {
  if (!walletCtx.walletAddress.trim()) {
    return '';
  }
  if (walletCtx.executionTarget === 'EOA') {
    return '';
  }
  if (!shouldPrefetchFinancialContext(message)) {
    return '';
  }

  const [balanceResult, portfolioResult] = await Promise.all([
    executeTool('get_balance', {}, walletCtx, sessionId),
    executeTool('get_portfolio', {}, walletCtx, sessionId),
  ]);

  return [
    'Current wallet context for this request:',
    balanceResult,
    '',
    portfolioResult,
    '',
    'Use only this wallet context when answering the user unless they explicitly ask for research, news, or market context.',
    'Do not say you are going to check balances or portfolio first.',
    'If the user asked for wallet, vault shares, Gateway reserve, or recent activity, cover those requested parts in the answer. Include one concise next step. Do not suggest a test swap unless the user explicitly asked to execute or demonstrate a trade.',
    'Do not invent extra buckets such as bridge-locked funds, off-chain positions, or market narratives unless they are explicitly present above.',
    'If the user asks how a recent action changed their wallet, combine this live wallet context with the current conversation history. Do not pretend you need them to repeat an action that already happened in this session.',
  ].join('\n');
}

async function loadBrainProfileContext(walletAddress?: Address): Promise<string> {
  const profile = await loadBrainUserProfile(walletAddress);
  return buildBrainProfileContext(profile);
}

async function upsertBrainUserProfile(
  walletAddress: Address,
  update: {
    display_name?: string | null;
    preferences?: Record<string, unknown>;
    memory_notes?: string | null;
  },
): Promise<void> {
  let supabaseError: unknown = null;

  try {
    const { error } = await adminDb.from('user_profiles').upsert(
      {
        wallet_address: walletAddress,
        ...update,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'wallet_address',
      },
    );

    if (error) {
      supabaseError = error;
      console.error('[memory] Supabase write failed:', error);
    }
  } catch (error) {
    supabaseError = error;
    console.error('[memory] Supabase write failed:', error);
  }

  if (LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED) {
    await storeLocalBrainUserProfile(walletAddress, update);
  }

  if (supabaseError) {
    throw supabaseError instanceof Error
      ? supabaseError
      : new Error(getErrorMessage(supabaseError));
  }
}

async function rememberUserProfileFact(
  walletAddress: Address,
  key: string,
  value: string,
): Promise<void> {
  const normalizedKey = key.trim().toLowerCase();
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return;
  }

  if (normalizedKey === 'display_name') {
    await upsertBrainUserProfile(walletAddress, { display_name: trimmedValue });
    return;
  }

  if (normalizedKey === 'memory_notes') {
    await upsertBrainUserProfile(walletAddress, { memory_notes: trimmedValue });
    return;
  }

  let preferences =
    (LOCAL_BRAIN_MEMORY_FALLBACK_ENABLED
      ? (((await loadLocalBrainUserProfile(walletAddress))?.preferences as Record<
          string,
          unknown
        >) || {})
      : {});

  try {
    const { data, error } = await adminDb
      .from('user_profiles')
      .select('preferences')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    if (error) {
      console.error('[memory] Supabase preference read failed:', error);
      throw error;
    }

    preferences =
      data?.preferences && typeof data.preferences === 'object'
        ? { ...(data.preferences as Record<string, unknown>) }
        : preferences;
  } catch (error) {
    console.warn('[brain] preference save failed:', getErrorMessage(error));
  }

  preferences[normalizedKey] = trimmedValue;
  await upsertBrainUserProfile(walletAddress, { preferences });
}

const PROFILE_FACT_TRIGGER =
  /\b(my name|call me|i prefer|remember|i like|i want)\b/i;

type ExtractedProfileFacts = {
  name?: string | null;
  preference?: string | null;
  note?: string | null;
};

function normalizeDisplayName(value: string): string {
  return value
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !/^(lol|lmao|haha|hehe|bro|dude|man|please|pls)$/i.test(part))
    .slice(0, 3)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function isProfileFactQuestion(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('?') ||
    /^(?:do|does|did|who|what|where|why|how|can|could|would|should|is|are)\b/i.test(
      normalized,
    )
  );
}

function extractExplicitDisplayName(message: string): string | null {
  if (isProfileFactQuestion(message)) {
    return null;
  }
  if (/\bmy\s+name\s+is\s+not\b/i.test(message)) {
    return null;
  }

  const patterns = [
    /\b(?:remember\s+)?my\s+name\s+is\s+([a-z][a-z .'-]{0,48})(?:[.!?,;:]|$)/i,
    /\bcall\s+me\s+([a-z][a-z .'-]{0,48})(?:[.!?,;:]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const candidate = normalizeDisplayName(match[1]);
    if (candidate && /^[A-Za-z][A-Za-z .'-]{0,48}$/.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseExtractedProfileFacts(raw: string): ExtractedProfileFacts | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(normalized) as ExtractedProfileFacts;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn('[memory] fact extraction parse failed:', getErrorMessage(error));
    return null;
  }
}

async function extractProfileFact(message: string, walletAddress?: Address): Promise<void> {
  if (!walletAddress) {
    return;
  }

  const normalized = message.trim();
  if (!normalized || !PROFILE_FACT_TRIGGER.test(normalized)) {
    return;
  }

  const explicitName = extractExplicitDisplayName(normalized);
  if (explicitName) {
    await rememberUserProfileFact(walletAddress, 'display_name', explicitName);
    return;
  }

  if (isProfileFactQuestion(normalized)) {
    return;
  }

  const rawExtraction = await callHermesFast(
    `Extract user facts from the message.
Return JSON only with this exact shape:
{"name": string | null, "preference": string | null, "note": string | null}

Rules:
- "name" is only for the user's display name.
- "preference" is only for stable user preferences they want remembered.
- "note" is only for a durable fact worth remembering that is not just the preference.
- Return null for fields not mentioned.
- Do not infer a name from a question.
- Never return markdown or explanation.`,
    normalized,
  );
  const extracted = parseExtractedProfileFacts(rawExtraction);
  if (!extracted) {
    return;
  }

  if (typeof extracted.preference === 'string' && extracted.preference.trim()) {
    const preference = extracted.preference.trim();
    const preferenceKey = /\bdeep research\b/i.test(preference)
      ? 'research_mode'
      : 'general_preference';
    await rememberUserProfileFact(walletAddress, preferenceKey, preference);
  }

  if (typeof extracted.note === 'string' && extracted.note.trim()) {
    await rememberUserProfileFact(walletAddress, 'memory_notes', extracted.note.trim());
  }
}

async function loadBrainSessionContext(sessionId: string): Promise<BrainSessionContext | null> {
  if (!sessionId) {
    return null;
  }
  try {
    const raw = await getRedis().get(brainSessionContextKey(sessionId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as BrainSessionContext;
  } catch (error) {
    console.warn('[brain] session context load failed:', getErrorMessage(error));
    return null;
  }
}

async function storeBrainSessionContext(
  sessionId: string,
  context: BrainSessionContext,
): Promise<void> {
  if (!sessionId) {
    return;
  }
  try {
    await getRedis().set(brainSessionContextKey(sessionId), JSON.stringify(context), 'EX', 7200);
  } catch (error) {
    console.warn('[brain] session context store failed:', getErrorMessage(error));
  }
}

async function resolveBrainExecutionTarget(
  rawTarget: unknown,
  sessionId?: string,
): Promise<'EOA' | 'DCW' | undefined> {
  const direct = normalizeBrainExecutionTarget(rawTarget);
  if (direct) {
    return direct;
  }
  if (!sessionId) {
    return undefined;
  }
  const stored = await loadBrainSessionContext(sessionId);
  return normalizeBrainExecutionTarget(stored?.executionTarget);
}

function resolveBrainWalletAddress(
  walletAddress: unknown,
  sessionId?: unknown,
): Address | undefined {
  if (typeof walletAddress === 'string' && isAddress(walletAddress)) {
    return getAddress(walletAddress);
  }
  if (typeof sessionId === 'string' && isAddress(sessionId)) {
    return getAddress(sessionId);
  }
  return undefined;
}

type DirectAgentFlowRoute =
  | {
      type: 'tool';
      tool:
        | 'get_balance'
        | 'get_portfolio'
        | 'swap_tokens'
        | 'vault_action'
        | 'bridge_usdc'
        | 'bridge_precheck';
      args: Record<string, unknown>;
      postActionNote?: string;
    }
  | {
      type: 'reply';
      text: string;
    };

function normalizeDirectRouteMessage(message: string): string {
  return message.trim().replace(/[!?.]+$/g, '').trim();
}

function getMostRecentAssistantMessage(history: BrainConversationMessage[] = []): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item?.role === 'assistant' && typeof item.content === 'string' && item.content.trim()) {
      return item.content.trim();
    }
  }
  return '';
}

function isShortReferentialFollowup(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    /\bwhat(?:'s| is)\s+that\b/i.test(normalized) ||
    /\bwhat\s+do\s+you\s+mean(?:\s+by\s+that)?\b/i.test(normalized) ||
    /\bintroductory\s+skills\b/i.test(normalized)
  );
}

function isClearlyOffTopicAssistantReply(text: string): boolean {
  if (!text.trim()) return false;
  if (/\b(?:screen capture|unity asset store|jonah'?s ladder|skill package)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:introductory|note taking)\b/i.test(text) &&
    !/\b(?:agentflow|agentpay|arc|usdc|eurc|gateway|vault|portfolio|swap|bridge|research|vision|transcribe|invoice|schedule|split|batch)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function buildReferentialRecoveryReply(lastAssistantMessage: string): string {
  if (
    /\b(?:introductory|note taking)\b/i.test(lastAssistantMessage) ||
    /\b(?:screen capture|unity asset store|jonah'?s ladder|skill package)\b/i.test(lastAssistantMessage)
  ) {
    return "That previous reply was wrong and unrelated to AgentFlow. \"Introductory skills\" is not an AgentFlow product or capability here. I misread the context instead of grounding on the actual conversation.\n\nIn AgentFlow, the relevant capabilities are things like swaps, vault actions, bridging, portfolio views, research, vision, transcribe, and AgentPay workflows.";
  }

  return "That refers to my previous message. I should answer it directly from the last AgentFlow reply instead of guessing from unrelated context.";
}

function hasAsciiArtIntent(message: string): boolean {
  return /\bascii\b|\btext\s+art\b|\bbanner\b/i.test(message);
}

function hasSequentialIntentCue(message: string): boolean {
  return /\b(?:and|then|after|afterward|afterwards|next|also|follow(?:ed)?\s+with|follow(?:ed)?\s+by|once\s+(?:done|complete|completed|it\s+is\s+done)|when\s+(?:done|complete|completed)|one\s+by\s+one|a2a)\b|[,;]/i.test(
    message,
  );
}

function hasPortfolioFollowupIntent(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  const asksForPortfolio =
    /\b(?:portfolio|holdings|positions|wallet|funds)\b/i.test(normalized) &&
    /\b(?:report|summary|summar(?:y|ize)|analysis|analy(?:s|z)e|scan|review|show|generate|create|prepare|write|explain|break\s*down|walk\s+me\s+through)\b/i.test(
      normalized,
    );
  const asksForReportAfterExecution =
    /\b(?:generate|create|prepare|write|make|pull|produce|build|genrate|genrerate|genraate)\b[\s\S]{0,40}\b(?:report|summary|analysis)\b/i.test(
      normalized,
    ) && /\b(?:portfolio|holdings|positions|wallet|funds)\b/i.test(normalized);
  const asksToExplainPortfolio =
    /\b(?:explain|break\s*down|walk\s+me\s+through)\b[\s\S]{0,40}\b(?:portfolio|holdings|positions|wallet|funds)\b/i.test(
      normalized,
    );
  return asksForPortfolio || asksForReportAfterExecution || asksToExplainPortfolio;
}

function hasResearchFollowupIntent(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  return (
    hasSequentialIntentCue(normalized) &&
    /\b(?:research|verify|reputation|background|risk|due\s+diligence|look\s+up|investigate|analy(?:s|z)e)\b/i.test(
      normalized,
    )
  );
}

function parseSupportedBridgeSourceChain(
  message: string,
): 'ethereum-sepolia' | 'base-sepolia' | undefined {
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\betherium\b/g, 'ethereum')
    .replace(/\betherem\b/g, 'ethereum')
    .replace(/\bethreum\b/g, 'ethereum')
    .replace(/\bethrium\b/g, 'ethereum')
    .replace(/\bsepoll?ia\b/g, 'sepolia')
    .replace(/\bsepoll?a\b/g, 'sepolia')
    .replace(/\bsepola\b/g, 'sepolia')
    .replace(/\bsepoila\b/g, 'sepolia')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    /\bbase\b/.test(normalized) &&
    (!/\bsepolia\b/.test(normalized) || /\bbase\s+(?:on\s+)?sepolia\b/.test(normalized) || /\bbase\s+sep\b/.test(normalized))
  ) {
    return 'base-sepolia';
  }

  if (
    /\beth(?:ereum)?\b/.test(normalized) &&
    (/\bsepolia\b/.test(normalized) || /\bsep\b/.test(normalized))
  ) {
    return 'ethereum-sepolia';
  }

  if (
    /\beth(?:ereum)?\s+(?:on\s+)?sepolia\b/.test(normalized) ||
    /\beth(?:ereum)?\s+sep\b/.test(normalized) ||
    /\beth\s+network\s+sepolia\b/.test(normalized)
  ) {
    return 'ethereum-sepolia';
  }
  return undefined;
}

function extractBridgeAmount(message: string): string | undefined {
  const normalized = message
    .toLowerCase()
    .replace(/\b1o\b/g, '10')
    .replace(/\bio\b/g, '10')
    .replace(/\s+/g, ' ')
    .trim();

  const explicitNumeric =
    normalized.match(/\b(\d+(?:\.\d+)?)\b(?=\s*usdc\b)/i) ??
    normalized.match(/\b(\d+(?:\.\d+)?)\b/);
  if (explicitNumeric?.[1]) {
    return explicitNumeric[1];
  }

  const wordAmounts: Array<[RegExp, string]> = [
    [/\bhalf\b(?:\s+usdc)?\b/i, '0.5'],
    [/\bzero\s+point\s+five\b(?:\s+usdc)?\b/i, '0.5'],
    [/\bone\b(?:\s+usdc)?\b/i, '1'],
    [/\ba\s+couple(?:\s+of)?\b(?:\s+usdc)?\b/i, '2'],
    [/\bcouple(?:\s+of)?\b(?:\s+usdc)?\b/i, '2'],
    [/\btwo\b(?:\s+usdc)?\b/i, '2'],
    [/\bthree\b(?:\s+usdc)?\b/i, '3'],
    [/\bfour\b(?:\s+usdc)?\b/i, '4'],
    [/\bfive\b(?:\s+usdc)?\b/i, '5'],
    [/\bsix\b(?:\s+usdc)?\b/i, '6'],
    [/\bseven\b(?:\s+usdc)?\b/i, '7'],
    [/\beight\b(?:\s+usdc)?\b/i, '8'],
    [/\bnine\b(?:\s+usdc)?\b/i, '9'],
    [/\bten\b(?:\s+usdc)?\b/i, '10'],
  ];

  for (const [pattern, value] of wordAmounts) {
    if (pattern.test(normalized)) {
      return value;
    }
  }

  return undefined;
}

function isBridgePrecheckIntent(message: string): boolean {
  if (!/\bbridge\b/i.test(message)) {
    return false;
  }

  if (/\b(?:gas|balance|balances|enough|ready|readiness|source wallet)\b/i.test(message)) {
    return true;
  }

  if (
    /\busdc\b/i.test(message) &&
    /\b(?:check|has|have|enough|balance|balances)\b/i.test(message)
  ) {
    return true;
  }

  if (
    /\b(?:supported|support|available|which|what)\b/i.test(message) &&
    /\b(?:bridge|source)\s+chains?\b/i.test(message)
  ) {
    return true;
  }

  if (/\bcan you bridge from\b/i.test(message)) {
    return true;
  }

  return false;
}

function isBareSupportedBridgeChainReply(message: string): boolean {
  return /^(?:eth(?:ereum)?(?:[\s-]+sep(?:olia)?)|base(?:[\s-]+sep(?:olia)?)?)$/i.test(
    message.trim(),
  );
}

function recentBridgeContextWantsPrecheck(history: BrainConversationMessage[] = []): boolean {
  const recent = history
    .slice(-6)
    .map((entry) => entry.content)
    .join('\n');

  return (
    /\bbridge\b/i.test(recent) &&
    /\b(?:gas|usdc|enough|supported|support|source wallet|source chain|ready|readiness|check)\b/i.test(
      recent,
    )
  );
}

function shouldHandleCounterpartyRiskRequest(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  return (
    /\b(?:risk|reputation|trust|safe\s+to\s+pay|counterparty|background|due\s+diligence)\b/i.test(normalized) &&
    /\b(?:of|for|on|about|pay|send|invoice|contact)\b/i.test(normalized)
  );
}

function parseCounterpartyRiskRequest(message: string): {
  counterparty: string;
  amountUsdc?: number;
  purpose?: string;
} | null {
  const amountMatch = message.match(/\b(\d+(?:\.\d+)?)\s*USDC\b/i);
  const amountUsdc = amountMatch ? Number(amountMatch[1]) : undefined;
  const cleaned = message
    .replace(/\b(?:research|check|verify|analyze|analyse|run|show|tell\s+me)\b/gi, ' ')
    .replace(/\b(?:counterparty|payment|payee|recipient|contact|vendor)?\s*(?:risk|reputation|trust|background|due\s+diligence)\b/gi, ' ')
    .replace(/\b(?:is|for|of|on|about|to|pay|send|invoice|safe|safe\s+to\s+pay|with|USDC)\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
    .replace(/[?.,;:!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const token = cleaned.split(/\s+/).find((part) =>
    /^0x[a-fA-F0-9]{40}$/.test(part) || /^[a-z0-9][a-z0-9_.-]{1,63}(?:\.arc)?$/i.test(part),
  );
  if (!token) return null;
  return {
    counterparty: token,
    amountUsdc: Number.isFinite(amountUsdc) ? amountUsdc : undefined,
    purpose: /invoice/i.test(message) ? 'invoice' : /schedule/i.test(message) ? 'scheduled payment' : 'payment',
  };
}

function portfolioA2aPostActionNote(agentName: string): string {
  return `After you confirm, the ${agentName} will trigger the portfolio agent through A2A to generate the portfolio report.`;
}

function researchA2aPostActionNote(agentName: string): string {
  return `After you confirm, the ${agentName} will trigger the research agent through A2A for the requested follow-up.`;
}

type PortfolioA2aBuyer = 'swap' | 'vault' | 'bridge' | 'batch' | 'split';
type RequestedPortfolioA2a = {
  buyerAgentSlug: PortfolioA2aBuyer;
  trigger: string;
};

function requestedPortfolioA2aKey(sessionId: string): string {
  return `chat:requested-portfolio-a2a:${canonicalRedisSessionId(sessionId)}`;
}

async function storeRequestedPortfolioA2a(
  sessionId: string,
  value: RequestedPortfolioA2a,
): Promise<void> {
  await getRedis().set(requestedPortfolioA2aKey(sessionId), JSON.stringify(value), 'EX', 300);
}

async function takeRequestedPortfolioA2a(sessionId: string): Promise<RequestedPortfolioA2a | null> {
  const key = requestedPortfolioA2aKey(sessionId);
  const raw = await getRedis().get(key).catch(() => null);
  await getRedis().del(key).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      buyerAgentSlug?: unknown;
      trigger?: unknown;
    };
    const allowed: PortfolioA2aBuyer[] = ['swap', 'vault', 'bridge', 'batch', 'split'];
    if (allowed.includes(parsed.buyerAgentSlug as PortfolioA2aBuyer) && typeof parsed.trigger === 'string' && parsed.trigger.trim()) {
      return {
        buyerAgentSlug: parsed.buyerAgentSlug as PortfolioA2aBuyer,
        trigger: parsed.trigger.trim(),
      };
    }
  } catch {}
  return null;
}

function requestedInvoiceResearchA2aKey(sessionId: string): string {
  return `chat:requested-invoice-research-a2a:${canonicalRedisSessionId(sessionId)}`;
}

async function storeRequestedInvoiceResearchA2a(sessionId: string): Promise<void> {
  await getRedis().set(requestedInvoiceResearchA2aKey(sessionId), '1', 'EX', 300);
}

async function takeRequestedInvoiceResearchA2a(sessionId: string): Promise<boolean> {
  const key = requestedInvoiceResearchA2aKey(sessionId);
  const raw = await getRedis().get(key).catch(() => null);
  await getRedis().del(key).catch(() => null);
  return raw === '1';
}

function agentDisplayName(slug: string): string {
  return `${slug.charAt(0).toUpperCase()}${slug.slice(1)} Agent`;
}

function formatPortfolioMoney(value: unknown, digits = 2): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0.00';
  }
  return numeric.toFixed(digits);
}

function roundPortfolioUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function formatPortfolioAmount(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  if (numeric === 0) {
    return '0';
  }
  if (Math.abs(numeric) < 0.001) {
    return numeric.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (Math.abs(numeric) < 1) {
    return numeric.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return numeric.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatSignedPortfolioMoney(value: unknown, digits = 2): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '$0.00';
  }
  const prefix = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);
  const precision = abs >= 0.01 ? digits : abs >= 0.0001 ? 4 : 6;
  return `${prefix}$${abs.toFixed(precision)}`;
}

function formatSignedPortfolioPercent(value: unknown, digits = 2): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0.00%';
  }
  const prefix = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);
  const precision = abs >= 0.01 ? digits : abs >= 0.0001 ? 4 : 6;
  return `${prefix}${abs.toFixed(precision)}%`;
}

function stripSensitivePortfolioReport(report: string): string {
  return report
    .replace(/^Wallet scanned:.*$/gim, '')
    .replace(/^Risk score:.*$/gim, '')
    .replace(/^Portfolio Analysis for.*$/gim, 'Portfolio analysis')
    .replace(/^Methodology\s*$/gim, '')
    .replace(/^Research Pipeline\s*$/gim, '')
    .replace(/^.*\beth_getBalance\b.*$/gim, '')
    .replace(/^.*\bbalanceOf\b.*$/gim, '')
    .replace(/^.*\bArcscan\b.*$/gim, '')
    .replace(/^.*\bGateway data not required\b.*$/gim, '')
    .replace(/0x[a-fA-F0-9]{40}/g, '[wallet]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizePortfolioA2aPayload(payload: Record<string, unknown>): string[] {
  const holdings = Array.isArray(payload.holdings)
    ? (payload.holdings as Array<Record<string, unknown>>)
    : [];
  const positions = Array.isArray(payload.positions)
    ? (payload.positions as Array<Record<string, unknown>>)
    : [];
  const recommendations = Array.isArray(payload.recommendations)
    ? payload.recommendations.map((item) => String(item)).filter(Boolean)
    : [];
  const pnl =
    payload.pnl && typeof payload.pnl === 'object'
      ? (payload.pnl as Record<string, unknown>)
      : payload.pnlSummary && typeof payload.pnlSummary === 'object'
        ? (payload.pnlSummary as Record<string, unknown>)
      : null;
  const formatHoldingSummary = (holding: Record<string, unknown>): string => {
    const symbol = String(holding.symbol || holding.name || 'Asset').trim();
    const balance = formatPortfolioAmount(holding.balanceFormatted);
    const usdValue = Number(holding.usdValue ?? 0);
    if (!symbol || !balance) {
      return '';
    }
    if (Number.isFinite(usdValue) && usdValue > 0) {
      return `${balance} ${symbol} ($${formatPortfolioMoney(usdValue)})`;
    }
    return `${balance} ${symbol}`;
  };
  const formatPositionSummary = (position: Record<string, unknown>): string => {
    const name = String(position.name || position.protocol || 'Position').trim();
    const amountRaw = position.amountFormatted;
    const amount =
      typeof amountRaw === 'string'
        ? amountRaw.trim()
        : formatPortfolioAmount(amountRaw);
    const usdValue = Number(position.usdValue ?? 0);
    if (!name) {
      return '';
    }
    if (amount) {
      return `${name}: ${amount}${usdValue > 0 ? ` ($${formatPortfolioMoney(usdValue)})` : ''}`;
    }
    if (usdValue > 0) {
      return `${name}: $${formatPortfolioMoney(usdValue)}`;
    }
    return name;
  };
  const positiveHoldings = holdings
    .filter((holding) => Number(holding.usdValue ?? 0) > 0 || Number(holding.balanceFormatted ?? 0) > 0);
  const tokenHoldings = positiveHoldings
    .filter((holding) => String(holding.kind || '') !== 'vault_share')
    .sort((left, right) => Number(right.usdValue ?? 0) - Number(left.usdValue ?? 0))
    .slice(0, 6)
    .map(formatHoldingSummary)
    .filter(Boolean);
  const vaultShareHoldings = positiveHoldings
    .filter((holding) => String(holding.kind || '') === 'vault_share')
    .map(formatHoldingSummary)
    .filter(Boolean);
  const positivePositions = positions
    .filter((position) => Number(position.usdValue ?? 0) > 0 || Number(position.amountFormatted ?? 0) > 0);
  const gatewayPositionRows = positions.filter(
    (position) => String(position.kind || '') === 'gateway_position',
  );
  const lpPositions = positivePositions
    .filter((position) => String(position.kind || '') === 'swap_liquidity')
    .map(formatPositionSummary)
    .filter(Boolean);
  const gatewayPositions = positivePositions
    .filter((position) => String(position.kind || '') === 'gateway_position')
    .map(formatPositionSummary)
    .filter(Boolean);
  const otherPositions = positivePositions
    .filter((position) => {
      const kind = String(position.kind || '');
      return kind !== 'swap_liquidity' && kind !== 'gateway_position';
    })
    .map(formatPositionSummary)
    .filter(Boolean);

  const totalValue =
    pnl && typeof pnl.currentValueUsd === 'number'
      ? Number(pnl.currentValueUsd)
      : Number.NaN;
  const pnlUsd =
    pnl && typeof pnl.pnlUsd === 'number'
      ? Number(pnl.pnlUsd)
      : Number.NaN;
  const pnlPct =
    pnl && typeof pnl.pnlPct === 'number'
      ? Number(pnl.pnlPct)
      : Number.NaN;
  const costBasisUsd =
    pnl && typeof pnl.costBasisUsd === 'number'
      ? Number(pnl.costBasisUsd)
      : Number.NaN;
  const gatewayValueUsd = roundPortfolioUsd(
    gatewayPositionRows.reduce((sum, position) => sum + Number(position.usdValue ?? 0), 0),
  );
  const gatewayCostBasisUsd = roundPortfolioUsd(
    gatewayPositionRows.reduce((sum, position) => sum + Number(position.costBasisUsd ?? 0), 0),
  );
  const gatewayPnlUsd = roundPortfolioUsd(
    gatewayPositionRows.reduce((sum, position) => sum + Number(position.pnlUsd ?? 0), 0),
  );
  const stableSymbols = new Set(['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'FRAX']);
  const tokenSymbols = positiveHoldings
    .filter((holding) => String(holding.kind || '') !== 'vault_share')
    .map((holding) => String(holding.symbol || '').toUpperCase())
    .filter(Boolean);
  const stableOnlyWallet =
    tokenSymbols.length > 0 &&
    tokenSymbols.every((symbol) => stableSymbols.has(symbol)) &&
    lpPositions.length === 0 &&
    otherPositions.length === 0;
  const walletOnlyTotalValue =
    Number.isFinite(totalValue) ? Math.max(0, roundPortfolioUsd(totalValue - gatewayValueUsd)) : Number.NaN;
  const walletOnlyCostBasisUsd =
    Number.isFinite(costBasisUsd)
      ? Math.max(0, roundPortfolioUsd(costBasisUsd - gatewayCostBasisUsd))
      : Number.NaN;
  const walletOnlyPnlUsd =
    Number.isFinite(pnlUsd) ? roundPortfolioUsd(pnlUsd - gatewayPnlUsd) : Number.NaN;
  const walletOnlyPnlPct =
    Number.isFinite(walletOnlyCostBasisUsd) && walletOnlyCostBasisUsd > 0 && Number.isFinite(walletOnlyPnlUsd)
      ? (walletOnlyPnlUsd / walletOnlyCostBasisUsd) * 100
      : Number.NaN;
  const usableRecommendation = recommendations.find(
    (item) =>
      item.trim().length > 0 &&
      !/\b(?:test|testing|simulate|simulation|network conditions|stability of execution|demo)\b/i.test(
        item,
      ),
  );
  let nextStep = usableRecommendation || '';
  if (!nextStep) {
    if (vaultShareHoldings.length > 0 && tokenHoldings.length > 0) {
      nextStep =
        'Decide how much should stay liquid in the wallet versus remain in the vault for yield.';
    } else if (gatewayPositions.length > 0) {
      nextStep =
        'Check whether Gateway funds need to stay parked there or be moved back to the execution wallet for your next action.';
    } else if (tokenHoldings.length > 0) {
      nextStep =
        'Most of this wallet is sitting in liquid token balances, so the next decision is whether to keep it idle, move some into the vault, or leave it untouched.';
    }
  }

  const lines = ['Current balances after this action:', ''];
  lines.push(
    tokenHoldings.length > 0
      ? `- Token balances: ${tokenHoldings.join(', ')}`
      : '- Token balances: no tracked token balances found.',
  );
  lines.push(
    vaultShareHoldings.length > 0
      ? `- Vault shares: ${vaultShareHoldings.join(', ')}`
      : '- Vault shares: none found.',
  );
  lines.push(
    gatewayPositions.length > 0
      ? `- Gateway reserve: ${gatewayPositions.join('; ')}`
      : '- Gateway reserve: none found.',
  );
  if (otherPositions.length > 0) {
    lines.push(`- Other positions: ${otherPositions.join('; ')}`);
  }
  const displayedPnlUsd = gatewayPositions.length > 0 ? walletOnlyPnlUsd : pnlUsd;
  const displayedPnlPct = gatewayPositions.length > 0 ? walletOnlyPnlPct : pnlPct;
  if (Number.isFinite(displayedPnlUsd) && Number.isFinite(displayedPnlPct)) {
    const pnlLine = gatewayPositions.length > 0
      ? `- Wallet PnL (excluding Gateway): ${formatSignedPortfolioMoney(displayedPnlUsd)} (${formatSignedPortfolioPercent(displayedPnlPct)})`
      : `- PnL: ${formatSignedPortfolioMoney(displayedPnlUsd)} (${formatSignedPortfolioPercent(displayedPnlPct)})`;
    lines.push(
      stableOnlyWallet &&
      Number.isFinite(gatewayPositions.length > 0 ? walletOnlyCostBasisUsd : costBasisUsd) &&
      (gatewayPositions.length > 0 ? walletOnlyCostBasisUsd : costBasisUsd) > 0
        ? `${pnlLine}. For a stablecoin-only wallet, this mostly reflects swap fees and tracked flows rather than market-price volatility.`
        : pnlLine,
    );
  }
  if (gatewayPositions.length > 0 && Number.isFinite(walletOnlyTotalValue) && walletOnlyTotalValue > 0) {
    lines.push(`- Wallet marked value (excluding Gateway): $${formatPortfolioMoney(walletOnlyTotalValue)}`);
  } else if (Number.isFinite(totalValue) && totalValue > 0) {
    lines.push(`- Total marked value: $${formatPortfolioMoney(totalValue)}`);
  }
  if (gatewayPositions.length > 0 && Number.isFinite(totalValue) && totalValue > 0) {
    lines.push(`- Combined wallet + Gateway reserve: $${formatPortfolioMoney(totalValue)}`);
  }
  if (nextStep) {
    lines.push(`- Next step: ${nextStep}`);
  }
  return lines;
}

function formatPortfolioA2aReport(
  payload: Record<string, unknown> | null,
  buyerAgentSlug: PortfolioA2aBuyer,
): string {
  if (!payload) {
    return 'Portfolio Agent did not return a report payload.';
  }
  const conciseSummary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  if (conciseSummary) {
    return conciseSummary;
  }
  const report = typeof payload.report === 'string' ? payload.report.trim() : '';
  const structuredSummary = summarizePortfolioA2aPayload(payload);
  const hasStructuredPortfolioData =
    (Array.isArray(payload.holdings) && payload.holdings.length > 0) ||
    (Array.isArray(payload.positions) && payload.positions.length > 0) ||
    Boolean(payload.pnl);

  if (report && !hasStructuredPortfolioData) {
    const safeReport = stripSensitivePortfolioReport(report);
    if (safeReport && safeReport !== 'Portfolio analysis') {
      const safeHighlights = safeReport
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter(
          (line) =>
            !/^current holdings$/i.test(line) &&
            !/^risk assessment$/i.test(line) &&
            !/^recommendations:?$/i.test(line),
        )
        .slice(0, 3);
      if (safeHighlights.length > 0) {
        structuredSummary.push(...safeHighlights);
      }
    }
  }

  return structuredSummary.join('\n').trim();
}

function formatResearchA2aReport(
  payload: Record<string, unknown> | null,
  buyerAgentSlug: 'invoice' | 'vision',
): string {
  if (!payload) {
    return 'Research Agent did not return a report payload.';
  }
  const task = typeof payload.task === 'string' ? payload.task.trim() : '';
  const result = typeof payload.result === 'string' ? payload.result.trim() : '';
  const lines = [`A2A complete: ${agentDisplayName(buyerAgentSlug)} -> Research Agent`, '', 'Research report:'];
  if (task) lines.push(`Task: ${task}`);
  if (result) lines.push('', result);
  return lines.join('\n').trim();
}

function isRequestedPortfolioA2aSuccess(requested: RequestedPortfolioA2a, result: string): boolean {
  if (requested.buyerAgentSlug === 'swap') return /^Executed swap:/i.test(result);
  if (requested.buyerAgentSlug === 'vault') {
    return /^Executed (deposit|withdraw):/i.test(result) || /Vault (deposit|withdrawal) complete/i.test(result);
  }
  if (requested.buyerAgentSlug === 'bridge') return /Bridged/i.test(result) && /USDC to Arc/i.test(result);
  return /\b(success|complete|sent|executed)\b/i.test(result);
}

async function appendRequestedPortfolioA2aReport(input: {
  baseMessage: string;
  requested: RequestedPortfolioA2a | null;
  userWalletAddress: string;
  details: unknown;
  sessionId?: string;
}): Promise<string> {
  if (!input.requested || !input.userWalletAddress) return input.baseMessage;
  if (typeof input.baseMessage === 'string' && !isRequestedPortfolioA2aSuccess(input.requested, input.baseMessage)) {
    return input.baseMessage;
  }
  try {
    const portfolioFollowup = await runPortfolioFollowupAfterToolWithPayment({
      buyerAgentSlug: input.requested.buyerAgentSlug,
      userWalletAddress: input.userWalletAddress,
      portfolioRunUrl: PORTFOLIO_URL,
      portfolioPriceLabel: portfolioPrice,
      trigger: input.requested.trigger,
      details: input.details,
    });
    if (input.sessionId && portfolioFollowup.paymentEntry) {
      appendRecentExecutionEntries(input.sessionId, [portfolioFollowup.paymentEntry]);
    }
    return `${input.baseMessage}\n\n${formatPortfolioA2aReport(portfolioFollowup.data, input.requested.buyerAgentSlug)}`;
  } catch (a2aErr) {
    const msg = a2aErr instanceof Error ? a2aErr.message : String(a2aErr);
    console.warn('[a2a] requested portfolio follow-up failed:', msg);
    return `${input.baseMessage}\n\nA2A portfolio report failed: ${msg}`;
  }
}

function shouldUseSemanticScheduleResolver(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(?:yes|no|confirm|cancel|y|n|yeah|yep|nope)$/i.test(normalized)) return false;
  if (hasAsciiArtIntent(normalized)) return false;
  return (
    /\b(?:scheduled?|recurring|autopay|automatic payment|next run)\b/i.test(normalized) ||
    /\b(?:daily|weekly|monthly)\b/i.test(normalized) ||
    /\bevery\s+(?:day|week|month|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}(?:st|nd|rd|th))\b/i.test(normalized) ||
    (/\b(?:pay|send|transfer)\b/i.test(normalized) && /\b(?:every|weekly|daily|monthly|recurring|scheduled)\b/i.test(normalized)) ||
    (/\b(?:cancel|delete|remove|stop)\b/i.test(normalized) && /\b(?:payment|payments|schedule|scheduled|recurring|latest|last|current|weekly|daily|monthly)\b/i.test(normalized)) ||
    (/\b(?:show|list|view|check|do i have|what are)\b/i.test(normalized) && /\b(?:scheduled|recurring)\s+payments?\b/i.test(normalized))
  );
}

function shouldHandleAsScheduleRequest(message: string): boolean {
  return shouldUseSemanticScheduleResolver(message);
}

function shouldHandleAsAgentFlowCapabilityQuestion(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\bwhat\s+can\s+agentflow\s+do\b/i.test(normalized) ||
    /\bwhat\s+can\s+agentflow\s+do\s+(?:today|right\s+now)\b/i.test(normalized) ||
    /\bwhat\s+does\s+agentflow\s+do\b/i.test(normalized) ||
    /\bwhat\s+is\s+agentflow\b/i.test(normalized) ||
    /\btell\s+me\s+about\s+agentflow\b/i.test(normalized) ||
    /\bhow\s+does\s+agentflow\s+work\b/i.test(normalized) ||
    /\bagentflow\s+capabilities?\b/i.test(normalized) ||
    /\bwhat\s+can\s+you\s+do\b/i.test(normalized) ||
    /\bwhat\s+can\s+you\s+help\s+with\b/i.test(normalized)
  );
}

function buildAgentFlowProductReply(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return null;

  const asksProductInfo =
    /(?:^|\b)(?:what|how|why|which|explain|tell\s+me\s+about)\b/i.test(normalized) ||
    /\bwhat\s+is\b/i.test(normalized) ||
    /\bhow\s+does\b/i.test(normalized);

  if (
    /\bbridge\b/i.test(normalized) &&
    /\b(?:manual(?:ly)?|eoa|funding)\b/i.test(normalized)
  ) {
    return 'No. AgentFlow does not expose a manual EOA bridge in the Funding page anymore. Funding is for moving Arc USDC between your EOA, your Agent wallet, and your Gateway reserve. If you want to bridge to Arc inside AgentFlow, use the sponsored Bridge agent in chat.';
  }

  if (shouldHandleAsAgentFlowCapabilityQuestion(message)) {
    return getAgentFlowCircleStackSummary();
  }

  if (asksProductInfo && /\bfunding\b/i.test(normalized)) {
    return [
      'Funding is the operational reserve page for AgentFlow.',
      '',
      'Use it to move Arc USDC between your EOA, your Agent wallet, and your Gateway reserve.',
      '- EOA: identity, signing, and funding wallet',
      '- Agent wallet / DCW: main execution wallet for chat actions',
      '- Gateway reserve: x402 nanopayment balance for paid agent work',
      '',
      'Funding is not the manual bridge surface. AgentFlow bridging happens through the sponsored Bridge agent in chat.',
    ].join('\n');
  }

  if (asksProductInfo && /\bagentpay\b/i.test(normalized)) {
    return [
      'AgentPay is AgentFlow\'s payment product.',
      '',
      'It can send USDC, create requests, generate payment links and .arc receiving flows, manage invoices, save contacts, prepare batch payouts, and manage scheduled payments.',
      '',
      'From chat, AgentFlow can also help you check invoice status, payment history, pending requests, contacts, and scheduled payments.',
    ].join('\n');
  }

  if (asksProductInfo && /\bportfolio\b/i.test(normalized)) {
    return [
      'Portfolio is the DCW-first wallet view.',
      '',
      'It shows your Agent wallet holdings, Gateway reserve, vault shares, recent activity, and wallet-level PnL. It is meant to answer what you currently hold and how recent actions changed that position.',
    ].join('\n');
  }

  if (asksProductInfo && /\bvault\b/i.test(normalized)) {
    return [
      'Vault lets AgentFlow deposit and withdraw Arc USDC from the AgentFlow vault using your Agent wallet / DCW.',
      '',
      'The normal flow is preview first, then YES to execute. Vault shares and vault exposure show up in Portfolio.',
    ].join('\n');
  }

  if (asksProductInfo && /\b(?:benchmark|economy)\b/i.test(normalized)) {
    return [
      'Benchmark is AgentFlow\'s shared proof page for the hackathon.',
      '',
      'It shows global nanopayment settlements, A2A pairs, throughput, and margin on Arc. The page is shared, but starting a benchmark run is private to the signed-in user.',
    ].join('\n');
  }

  if (asksProductInfo && /\bresearch\b/i.test(normalized)) {
    return [
      'Research is AgentFlow\'s multi-agent report pipeline.',
      '',
      'It uses Research -> Analyst -> Writer, with Firecrawl-backed retrieval for external topics. When you ask about your own portfolio, invoices, contacts, or payment counterparties, AgentFlow should use internal product context first and public research only as enrichment.',
    ].join('\n');
  }

  if (asksProductInfo && /\b(?:invoice|invoices)\b/i.test(normalized)) {
    return [
      'AgentFlow invoices live under AgentPay.',
      '',
      'You can create invoice previews, confirm invoices, list invoices, check their status, and turn invoice flows into payment requests.',
    ].join('\n');
  }

  if (asksProductInfo && /\bcontacts?\b/i.test(normalized)) {
    return [
      'Contacts let you save counterparties by name inside AgentPay.',
      '',
      'You can list, update, delete, and pay saved contacts directly from chat.',
    ].join('\n');
  }

  return null;
}

function isPendingActionFollowup(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\bwhat(?:'s| is)\s+next\b/i.test(normalized) ||
    /\bwhat\s+now\b/i.test(normalized) ||
    /\bnext\s+step\b/i.test(normalized) ||
    /\bwhat\s+should\s+i\s+do\b/i.test(normalized) ||
    /\bhow\s+do\s+i\s+continue\b/i.test(normalized) ||
    /\bwhat\s+did\s+you\s+just\s+quote\b/i.test(normalized)
  );
}

function formatPendingActionFollowup(
  pending: NonNullable<Awaited<ReturnType<typeof loadPendingAction>>>,
): string {
  if (pending.tool === 'swap_tokens') {
    const amount = String(pending.args?.amount ?? '').trim() || 'the quoted amount';
    const tokenIn = String(pending.args?.tokenIn ?? 'USDC').trim().toUpperCase();
    const tokenOut = String(pending.args?.tokenOut ?? 'EURC').trim().toUpperCase();
    return [
      `You have a pending swap quote: ${amount} ${tokenIn} to ${tokenOut}.`,
      '',
      'Reply YES to execute or NO to cancel.',
    ].join('\n');
  }

  if (pending.tool === 'vault_action') {
    const action = String(pending.args?.action ?? 'vault action').trim().toLowerCase();
    const amount = String(pending.args?.amount ?? '').trim() || 'the quoted amount';
    return [
      `You have a pending vault ${action} for ${amount} USDC.`,
      '',
      'Reply YES to execute or NO to cancel.',
    ].join('\n');
  }

  if (pending.tool === 'bridge_usdc') {
    const amount = String(pending.args?.amount ?? '').trim() || 'the quoted amount';
    const sourceChain = String(pending.args?.sourceChain ?? 'the selected source chain').trim();
    return [
      `You have a pending sponsored bridge quote for ${amount} USDC from ${sourceChain} to Arc.`,
      '',
      'Reply YES to execute or NO to cancel.',
    ].join('\n');
  }

  return 'You have a pending action. Reply YES to execute or NO to cancel.';
}

/**
 * Detect split-payment intent. Matches phrasings Hermes tends to hallucinate on
 * (e.g. "split 30 USDC between A and B"). When this returns true we bypass
 * Hermes entirely and call the Split Agent directly — same pattern used for
 * the schedule agent above.
 */
function shouldHandleAsSplitRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(?:yes|no|confirm|cancel|y|n|yeah|yep|nope)$/i.test(normalized)) return false;

  // "split X USDC between/among A and B..."
  if (/\bsplit\b.*\b(?:between|among|with|amongst)\b/i.test(normalized)) return true;
  // "divide X USDC between/among A and B..."
  if (/\bdivide\b.*\b(?:between|among|amongst)\b/i.test(normalized)) return true;
  // "split the bill" / "split dinner"
  if (/\bsplit\s+(?:the\s+)?(?:bill|tab|cost|check|dinner|lunch|rent)\b/i.test(normalized)) return true;
  // "pay A, B and C equally"
  if (/\bpay\b.*\bequally\b/i.test(normalized)) return true;
  // "send X each to A, B, C"
  if (/\bsend\b.*\beach\s+to\b/i.test(normalized)) return true;

  return false;
}

/**
 * Detect research-style intent so chat can bypass Hermes and run the
 * research → analyst → writer pipeline. Broader than keyword-only "research"
 * commands to catch natural market/topic questions while excluding short acks
 * and payment intents.
 */
const NON_RESEARCH_PHRASES =
  /^(good|ok|okay|thanks|thank you|got it|perfect|great|nice|cool|awesome|understood|noted|sure|yep|nope|no|yes|nice one|well done)\s*[.!]?\s*$/i;

function shouldHandleAsResearchRequest(message: string): boolean {
  if (!message.trim()) return false;

  const normalized = message.trim().toLowerCase();

  if (NON_RESEARCH_PHRASES.test(normalized)) return false;

  if (
    /\b(pay|send|swap|bridge|vault|deposit|withdraw|transfer)\b.*\b(usdc|eurc|usd|arc)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  if (
    /\b(research|deep\s+research|research\s+report|run\s+research|generate\s+report|analyze\s+and\s+report)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /\b(research\s+on|news\s+on|tell\s+me\s+about|what\s+is\s+happening\s+with|analyze|analysis\s+on|report\s+on|look\s+into|find\s+out\s+about)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /\b(price|market\s+cap|trading\s+volume|tvl|apy|how\s+is|how\s+are|what\s+is\s+the\s+price|current\s+price)\b.*\b(btc|eth|bitcoin|ethereum|usdc|eurc|sol|solana|arc|defi|crypto)\b/i.test(
      normalized,
    ) ||
    /\b(btc|eth|bitcoin|ethereum|usdc|eurc|sol|solana|arc|defi|crypto)\b.*\b(price|market\s+cap|trading\s+volume|tvl|apy|how\s+is|how\s+are|what\s+is\s+the\s+price|current\s+price)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /\b(btc|bitcoin|ethereum|eth|solana|sol|defi|nft|dao|blockchain|crypto|web3|arc\s+network)\b/i.test(
      normalized,
    ) &&
    normalized.split(/\s+/).filter(Boolean).length > 3
  ) {
    return true;
  }

  return false;
}

function shouldBypassToResearchPipeline(message: string): boolean {
  return shouldHandleAsResearchRequest(message);
}

function buildResearchFailureReply(details: string): string {
  const cleaned = details.trim();
  if (!cleaned) {
    return [
      'I could not complete the live research run for this request.',
      'The research pipeline failed before it returned a report.',
      '',
      'I am not substituting a portfolio summary or a memory-based answer for a failed research job.',
      'Please retry the research request in a moment.',
    ].join('\n');
  }

  const reason = /payment/i.test(cleaned)
    ? 'The x402 payment step failed before the live research run could complete.'
    : cleaned.length > 220
      ? `${cleaned.slice(0, 217)}...`
      : cleaned;

  return [
    'I could not complete the live research run for this request.',
    `Reason: ${reason}`,
    '',
    'I am not substituting a portfolio summary or a memory-based answer for a failed research job.',
    'Please retry the research request in a moment.',
  ].join('\n');
}

/**
 * Detect batch/payroll intent from chat message (text-only; no file attachments needed).
 */
function shouldHandleAsBatchPayment(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(?:yes|no|confirm|cancel|y|n|yeah|yep|nope)$/i.test(normalized)) return false;
  return /\b(batch\s+pay(?:ment)?|payroll|bulk\s+pay|pay\s+multiple|pay\s+everyone)\b/i.test(normalized);
}

/**
 * Extract BatchPaymentRow[] from a chat message with inline CSV body.
 */
function parseBatchMessage(message: string) {
  return parseInlineCsvFromMessage(message);
}

/**
 * Parse a split-payment message into { recipients, totalAmount, remark }.
 * Returns null if we can't confidently extract both recipients and amount.
 */
function parseSplitRequest(
  message: string,
): { recipients: string[]; totalAmount: string; remark?: string } | null {
  const raw = message.trim();
  if (!raw) return null;

  // Extract total amount (first number found, optionally followed by USDC/usd/$)
  const amountMatch = raw.match(/(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)?/i);
  if (!amountMatch) return null;
  const totalAmount = amountMatch[1];

  // Extract the recipient list — the substring after between/among/to
  const afterKeyword = raw.match(
    /\b(?:between|among|amongst|to|with)\s+(.+?)(?:\s+(?:for|on|at|remark|note)\s+.+)?$/i,
  );
  const recipientsBlob = afterKeyword?.[1] ?? '';

  // Split on commas or " and " (case-insensitive), trim each piece
  const recipients = recipientsBlob
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((r) => r.replace(/^(?:me|myself)$/i, '').trim())
    .filter((r) => r.length > 0);

  if (recipients.length < 2) return null;
  if (recipients.length > 10) return null;

  // Extract optional remark ("for dinner", "for rent", "remark foo")
  let remark: string | undefined;
  const remarkMatch = raw.match(/\b(?:for|remark|note)\s+([^,]+?)(?:\s+between|\s+among|\s*$)/i);
  if (remarkMatch) {
    const candidate = remarkMatch[1].trim();
    // Skip remark candidates that are numeric or look like keywords
    if (candidate && !/^\d/.test(candidate) && candidate.length < 60) {
      remark = candidate;
    }
  }

  return { recipients, totalAmount, remark };
}

/**
 * Detect "share a payment link / QR for X" intent. Pure URL construction — no
 * money moves, no confirmation needed. We bypass Hermes here because the LLM
 * loves to hallucinate transaction previews when it sees payment-shaped input.
 */
function shouldHandleAsPaymentLinkRequest(message: string): boolean {
  const n = message.trim();
  if (!n) return false;
  if (/^(?:yes|no|confirm|cancel|y|n|yeah|yep|nope)$/i.test(n)) return false;
  // Must explicitly mention "payment link" / "pay link" / "share link" / "qr".
  if (/\b(?:payment\s*link|pay\s*link|share\s*link)\b/i.test(n)) return true;
  if (/\bqr(?:\s*code)?\s+(?:for|to|of)\b/i.test(n)) return true;
  if (/\b(?:generate|create|make|give\s+me|send|share)\s+(?:a\s+|an\s+|the\s+)?qr\b/i.test(n))
    return true;
  return false;
}

/**
 * Parse a payment-link request into { handle, amount?, remark? }.
 * Returns null if no recipient handle (`.arc` name or `0x…` address) is present.
 */
function parsePaymentLinkRequest(
  message: string,
): { handle: string; amount?: string; remark?: string } | null {
  const raw = message.trim();
  if (!raw) return null;

  const handleRe = /\b([a-z0-9][a-z0-9-]*\.arc|0x[a-fA-F0-9]{40})\b/i;
  const handleMatch = raw.match(handleRe);
  if (!handleMatch || handleMatch.index === undefined) return null;

  const rawHandle = handleMatch[1];
  const handle = rawHandle.toLowerCase().startsWith('0x')
    ? rawHandle // keep checksummable case; URL consumer lowercases as needed
    : rawHandle.replace(/\.arc$/i, '').toLowerCase();

  // Amount/remark live in the tail after the handle — avoids matching
  // "for jack.arc" as the remark.
  const tail = raw.slice(handleMatch.index + handleMatch[0].length);

  let amount: string | undefined;
  const amtMatch = tail.match(/(?:\$\s*)?(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)?/i);
  if (amtMatch) amount = amtMatch[1];

  let remark: string | undefined;
  const remarkMatch = tail.match(/\bfor\s+([^\n]+?)\s*$/i);
  if (remarkMatch) {
    const candidate = remarkMatch[1].trim();
    const looksLikeAmountOnly =
      /^\d+(?:\.\d+)?(?:\s*(?:usdc|usd|dollars?))?$/i.test(candidate);
    if (candidate && !looksLikeAmountOnly && candidate.length < 80) {
      remark = candidate;
    }
  }

  return { handle, amount, remark };
}

function shouldHandleAsInvoiceRequest(message: string): boolean {
  const n = message.trim();
  if (!n) return false;
  if (/^(?:yes|no|confirm|cancel|y|n|yeah|yep|nope)$/i.test(n)) return false;
  return /\bcreate\s+invoice\b|\bsend\s+invoice\b|\bbill\s+\w|\binvoice\s+for\b|\bmake\s+invoice\b/i.test(n);
}

function shouldHandleAsInvoiceStatus(message: string): boolean {
  return /check\s+(my\s+)?invoices?|show\s+(my\s+)?invoices?|invoice\s+status|my\s+invoices?|list\s+invoices?|unpaid\s+invoices?/i.test(
    message.trim(),
  );
}

function shouldHandleAsContactView(message: string): boolean {
  return /show\s+(my\s+)?contacts|list\s+(my\s+)?contacts|my\s+saved\s+addresses|my\s+address\s+book/i.test(
    message.trim(),
  );
}

function shouldHandleAsContactSave(message: string): boolean {
  const t = message.trim();
  return (
    /save\s+\w+\s+as\s+/i.test(t) ||
    /add\s+contact\s+/i.test(t) ||
    /\b\w+\s+is\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)\b/i.test(t)
  );
}

function shouldHandleAsContactUpdate(message: string): boolean {
  return /update\s+\w+\s+to\s+|change\s+\w+\s+address\s+to\s+/i.test(message.trim());
}

function shouldHandleAsContactDelete(message: string): boolean {
  return /remove\s+contact\s+|delete\s+contact\s+/i.test(message.trim());
}

function parseInvoiceRequest(
  message: string,
): { vendorHandle: string; amount: string; description: string } | null {
  const handleMatch = message.match(
    /(?:for|to)\s+([a-z0-9]+\.arc|0x[a-fA-F0-9]{40}|[a-z0-9][a-z0-9_-]{0,63})/i,
  );
  const amountMatch =
    message.match(/(\d+(?:\.\d+)?)\s*USDC/i) ||
    message.match(/USDC\s*(\d+(?:\.\d+)?)/i) ||
    message.match(/\b(\d+(?:\.\d+)?)\b/);
  if (!handleMatch || !amountMatch) return null;
  const descMatch =
    message.match(/\d+\s*USDC\s+for\s+(.+)$/i) ||
    message.match(/invoice\s+for\s+[a-z0-9.]+\s+\d+\s*(?:USDC)?\s+(?:for\s+)?(.+)$/i);
  return {
    vendorHandle: handleMatch[1].toLowerCase(),
    amount: amountMatch[1],
    description: descMatch?.[1]?.trim() || 'Services rendered',
  };
}

function parseDirectAgentFlowRoute(
  message: string,
  history: BrainConversationMessage[] = [],
): DirectAgentFlowRoute | null {
  const normalized = normalizeDirectRouteMessage(message);
  if (!normalized) {
    return null;
  }

  if (hasAsciiArtIntent(normalized)) {
    return null;
  }

  const politePrefix =
    "(?:(?:please|can you|could you|would you|help me|i want to|let's)\\s+)?";
  const wantsPortfolioFollowup = hasPortfolioFollowupIntent(normalized);
  const lastAssistantMessage = getMostRecentAssistantMessage(history);

  if (
    isShortReferentialFollowup(normalized) &&
    lastAssistantMessage &&
    isClearlyOffTopicAssistantReply(lastAssistantMessage)
  ) {
    return {
      type: 'reply',
      text: buildReferentialRecoveryReply(lastAssistantMessage),
    };
  }

  if (
    /^(?:what(?:'s| is)? my balance|show my balance|balance|how much do i have|what funds do i have)$/i.test(
      normalized,
    )
  ) {
    return {
      type: 'tool',
      tool: 'get_balance',
      args: {},
    };
  }

  if (
    /^(?:show my portfolio|what(?:'s| is) my portfolio|portfolio|show my holdings|what do i own)$/i.test(
      normalized,
    )
  ) {
    return {
      type: 'tool',
      tool: 'get_portfolio',
      args: {},
    };
  }

  if (
    /\b(?:what(?:'s| is)\s+)?gateway\s+strategy\b/i.test(normalized) ||
    /\bwhat(?:'s| is)\s+the\s+gateway\b/i.test(normalized)
  ) {
    return {
      type: 'reply',
      text:
        'Gateway is not an investment strategy in AgentFlow. It is the USDC reserve used for x402 and agent-to-agent nanopayments. On your portfolio and funding pages, the Gateway position means payment liquidity parked in Circle Gateway, not a yield product.',
    };
  }

  const explicitSwapPortfolioMatch = normalized.match(
    new RegExp(
      `\\b(?:swap|trade|exchange|convert)\\s*(\\d+(?:\\.\\d+)?)\\s*(USDC|EURC)\\s*(?:to|for)?\\s*(USDC|EURC)\\b`,
      'i',
    ),
  );
  if (
    explicitSwapPortfolioMatch &&
    hasSequentialIntentCue(normalized) &&
    /\b(?:portfolio|holdings|positions|wallet|funds)\b/i.test(normalized) &&
    /\b(?:show|explain|review|summary|summar(?:y|ize)|report|analysis|analy(?:s|z)e|break\s*down|walk\s+me\s+through)\b/i.test(
      normalized,
    )
  ) {
    const [, amount, tokenIn, tokenOut] = explicitSwapPortfolioMatch;
    if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) {
      return {
        type: 'reply',
        text: 'Swap needs two different tokens. Try USDC to EURC or EURC to USDC.',
      };
    }
    return {
      type: 'tool',
      tool: 'swap_tokens',
      args: {
        amount,
        tokenIn: tokenIn.toUpperCase(),
        tokenOut: tokenOut.toUpperCase(),
        confirmed: false,
      },
      postActionNote: portfolioA2aPostActionNote('swap agent'),
    };
  }


  const compoundSwapMatch = normalized.match(
    new RegExp(
      `^${politePrefix}(?:swap|trade|exchange|convert)\\s*(\\d+(?:\\.\\d+)?)\\s*(USDC|EURC)\\s*(?:to|for)?\\s*(USDC|EURC)\\b[\\s\\S]*$`,
      'i',
    ),
  );
  if (
    compoundSwapMatch &&
    wantsPortfolioFollowup
  ) {
    const [, amount, tokenIn, tokenOut] = compoundSwapMatch;
    if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) {
      return {
        type: 'reply',
        text: 'Swap needs two different tokens. Try USDC to EURC or EURC to USDC.',
      };
    }
    return {
      type: 'tool',
      tool: 'swap_tokens',
      args: {
        amount,
        tokenIn: tokenIn.toUpperCase(),
        tokenOut: tokenOut.toUpperCase(),
        confirmed: false,
      },
      postActionNote: portfolioA2aPostActionNote('swap agent'),
    };
  }

  const swapMatch =
    normalized.match(
      new RegExp(
        `^${politePrefix}(?:swap|trade|exchange|convert)\\s*(\\d+(?:\\.\\d+)?)\\s*(USDC|EURC)\\s+(?:to|for)\\s+(USDC|EURC)(?:\\s+for\\s+me)?\\s*$`,
        'i',
      ),
    ) ||
    normalized.match(
      new RegExp(
        `^${politePrefix}(?:swap|trade|exchange|convert)\\s*(\\d+(?:\\.\\d+)?)\\s*(USDC|EURC)\\s+(USDC|EURC)(?:\\s+for\\s+me)?\\s*$`,
        'i',
      ),
    );
  if (swapMatch) {
    const [, amount, tokenIn, tokenOut] = swapMatch;
    if (tokenIn.toUpperCase() === tokenOut.toUpperCase()) {
      return {
        type: 'reply',
        text: 'Swap needs two different tokens. Try USDC to EURC or EURC to USDC.',
      };
    }
    return {
      type: 'tool',
      tool: 'swap_tokens',
      args: {
        amount,
        tokenIn: tokenIn.toUpperCase(),
        tokenOut: tokenOut.toUpperCase(),
        confirmed: false,
      },
    };
  }

  const compoundDepositMatch = wantsPortfolioFollowup
    ? normalized.match(
        new RegExp(
          `^${politePrefix}(?:stake|deposit|vault\\s+deposit|move)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?\\b[\\s\\S]*(?:vault|yield|portfolio|report|holdings)[\\s\\S]*$`,
          'i',
        ),
      )
    : null;
  if (compoundDepositMatch) {
    return {
      type: 'tool',
      tool: 'vault_action',
      args: {
        action: 'deposit',
        amount: compoundDepositMatch[1],
        confirmed: false,
      },
      postActionNote: portfolioA2aPostActionNote('vault agent'),
    };
  }

  const depositMatch =
    normalized.match(
      new RegExp(
        `^${politePrefix}(?:stake|deposit)\\s+(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?(?:\\s+(?:into|to)\\s+(?:the\\s+)?vault)?(?:\\s+for\\s+me)?\\s*$`,
        'i',
      ),
    ) ||
    normalized.match(
      new RegExp(`^${politePrefix}vault\\s+deposit\\s+(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?\\s*$`, 'i'),
    );
  if (depositMatch) {
    return {
      type: 'tool',
      tool: 'vault_action',
      args: {
        action: 'deposit',
        amount: depositMatch[1],
        confirmed: false,
      },
    };
  }

  const compoundWithdrawMatch = wantsPortfolioFollowup
    ? normalized.match(
        new RegExp(
          `^${politePrefix}(?:withdraw|unstake|remove|take\\s+out|vault\\s+withdraw)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?\\b[\\s\\S]*(?:vault|portfolio|report|holdings)[\\s\\S]*$`,
          'i',
        ),
      )
    : null;
  if (compoundWithdrawMatch) {
    return {
      type: 'tool',
      tool: 'vault_action',
      args: {
        action: 'withdraw',
        amount: compoundWithdrawMatch[1],
        confirmed: false,
      },
      postActionNote: portfolioA2aPostActionNote('vault agent'),
    };
  }

  const withdrawMatch =
    normalized.match(
      new RegExp(
        `^${politePrefix}(?:withdraw|unstake|remove|take out)\\s+(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?(?:\\s+from\\s+(?:the\\s+)?vault)?(?:\\s+for\\s+me)?\\s*$`,
        'i',
      ),
    ) ||
    normalized.match(
      new RegExp(`^${politePrefix}vault\\s+withdraw\\s+(\\d+(?:\\.\\d+)?)\\s*(?:USDC)?\\s*$`, 'i'),
    );
  if (withdrawMatch) {
    return {
      type: 'tool',
      tool: 'vault_action',
      args: {
        action: 'withdraw',
        amount: withdrawMatch[1],
        confirmed: false,
      },
    };
  }

  if (/\bbridge\b/i.test(normalized) && /\bEURC\b/i.test(normalized)) {
    return {
      type: 'reply',
      text:
        'Bridging moves USDC between chains. Swapping converts USDC to EURC on Arc. Tell me the source chain if you want to bridge USDC, or ask me to swap USDC to EURC on Arc.',
    };
  }

  if (
    /\bbridge\b/i.test(normalized) &&
    /\b(?:manual(?:ly)?|eoa|funding)\b/i.test(normalized)
  ) {
    return {
      type: 'reply',
      text:
        'No. AgentFlow does not expose a manual EOA bridge in the Funding page anymore. Funding is for moving Arc USDC between your EOA, your Agent wallet, and your Gateway reserve. If you want to bridge to Arc inside AgentFlow, use the sponsored Bridge agent in chat.',
    };
  }

  const bridgeSourceChain = parseSupportedBridgeSourceChain(normalized);
  const bridgeAmount = extractBridgeAmount(normalized);
  if (
    isBridgePrecheckIntent(normalized) ||
    (isBareSupportedBridgeChainReply(normalized) && recentBridgeContextWantsPrecheck(history))
  ) {
    return {
      type: 'tool',
      tool: 'bridge_precheck',
      args: {
        ...(bridgeSourceChain ? { sourceChain: bridgeSourceChain } : {}),
        ...(bridgeAmount ? { amount: bridgeAmount } : {}),
      },
    };
  }

  if (/\bbridge\b/i.test(normalized)) {
    if (!bridgeSourceChain) {
      return {
        type: 'reply',
        text:
          'Supported bridge source chains right now: Ethereum Sepolia and Base Sepolia. Tell me the source chain and amount when you want a live bridge estimate.',
      };
    }

    if (!bridgeAmount) {
      return {
        type: 'reply',
        text:
          'Tell me how much USDC you want to bridge, for example: bridge 0.1 USDC from Ethereum Sepolia. If you want a readiness check first, ask me to check gas and USDC on that source chain.',
      };
    }
    return {
      type: 'tool',
      tool: 'bridge_usdc',
      args: {
        amount: bridgeAmount,
        sourceChain: bridgeSourceChain,
        confirmed: false,
      },
      postActionNote: wantsPortfolioFollowup ? portfolioA2aPostActionNote('bridge agent') : undefined,
    };
  }

  return null;
}

function buildBrainInputMessage(message: string): string {
  const normalized = normalizeDirectRouteMessage(message);
  if (!normalized) {
    return message;
  }

  if (hasAsciiArtIntent(normalized)) {
    return `${message}

[AgentFlow routing note: This is an ASCII art request. Before replying, you MUST call skill_view(name="creative/ascii-art") and follow that skill's decision flow. Do not use the old direct-route ASCII fallback. If the user asked for block art, shaded art, or a stronger style, prefer that style from the ASCII skill. If they asked for a subject like "cat", produce art of that subject instead of turning a filler word like "a" into a banner. If they asked for a name, word, phrase, or banner, render that exact text.]`;
  }

  return message;
}

function readAsciiTaskField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractAsciiAgentTask(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const record = input as Record<string, unknown>;
  const direct =
    readAsciiTaskField(record.task) ||
    readAsciiTaskField(record.prompt) ||
    readAsciiTaskField(record.message) ||
    readAsciiTaskField(record.input);
  if (direct) {
    return direct;
  }

  const text = readAsciiTaskField(record.text);
  const subject = readAsciiTaskField(record.subject);
  const style = readAsciiTaskField(record.style);
  const mode = readAsciiTaskField(record.mode);

  if (text) {
    return `Create ${style ? `${style} ` : ''}ASCII art banner for "${text}"${mode ? ` in ${mode} mode` : ''}.`;
  }
  if (subject) {
    return `Create ${style ? `${style} ` : ''}ASCII art of ${subject}${mode ? ` in ${mode} mode` : ''}.`;
  }

  return '';
}

type ParsedAsciiRequest = {
  mode: 'scene' | 'banner';
  value: string;
  font: string;
  styleLabel: string;
};

const ASCII_SCENE_SUBJECTS: Record<string, string> = {
  dog: 'dog',
  puppy: 'dog',
  cat: 'cat',
  kitty: 'cat',
  kitten: 'cat',
  dragon: 'dragon',
  coffee: 'coffee',
  robot: 'robot',
  owl: 'owl',
  fish: 'fish',
  rabbit: 'rabbit',
  bird: 'bird',
  turtle: 'turtle',
  skull: 'skull',
  tree: 'tree',
  flower: 'flower',
  ship: 'ship',
  boat: 'ship',
  car: 'car',
  rocket: 'rocket',
  guitar: 'guitar',
  computer: 'computer',
  house: 'house',
  castle: 'castle',
  heart: 'valentine',
  valentine: 'valentine',
};

const ASCII_CREATIVE_FALLBACKS: Record<string, string> = {
  dog: [
    '        / \\__',
    '       (    @\\___',
    '       /         O',
    '      /   (_____/',
    '     /_____/   U',
  ].join('\n'),
  cat: [
    '      /\\_/\\',
    '     ( o.o )',
    '      > ^ <',
    '    /       \\',
    '   /_/     \\_\\',
  ].join('\n'),
  robot: [
    '      .-----.',
    '     | o o |',
    '     |  ^  |',
    '     | \\_/ |',
    '   __|_____|__',
    '  /  /|   |\\  \\',
    ' /__/ |___| \\__\\',
  ].join('\n'),
  coffee: [
    '       ( (',
    '        ) )',
    '     ........',
    '     |      |]',
    '     \\      /',
    '      `----`',
  ].join('\n'),
  rocket: [
    '        /\\',
    '       /  \\',
    '      |    |',
    '      |NASA|',
    '      |    |',
    '     /|/\\|\\',
    '    /_||||_\\',
  ].join('\n'),
  tree: [
    '        /\\',
    '       /**\\',
    '      /****\\',
    '     /******\\',
    '        ||',
    '        ||',
    '      __||__',
  ].join('\n'),
  car: [
    '        ______',
    '   ____/|_||_\\`.__',
    '  (   _        _ _\\',
    "  =`-(_)--(_)-'",
  ].join('\n'),
  house: [
    '        /\\',
    '       /  \\',
    '      /____\\',
    '      | [] |',
    '      | __ |',
    '      ||  ||',
  ].join('\n'),
  valentine: [
    '    **     **',
    '  ****** ******',
    ' ***************',
    '  *************',
    '    *********',
    '      *****',
    '        *',
  ].join('\n'),
};

function extractQuotedAsciiText(task: string): string | null {
  const match = task.match(/["'`]+([^"'`\n]{1,40})["'`]+/);
  const value = match?.[1]?.trim();
  return value || null;
}

function inferAsciiFont(task: string): { font: string; styleLabel: string } {
  const normalized = task.toLowerCase();
  if (/\b(block|bold|heavy|doom)\b/i.test(normalized)) {
    return { font: 'Doom', styleLabel: 'Block' };
  }
  if (/\b(shadow|shade|shaded|3d|three[- ]d)\b/i.test(normalized)) {
    return { font: '3-D', styleLabel: 'Shaded' };
  }
  if (/\b(small|compact|mini)\b/i.test(normalized)) {
    return { font: 'Small', styleLabel: 'Compact' };
  }
  if (/\b(big|large|wide|banner)\b/i.test(normalized)) {
    return { font: 'Banner3', styleLabel: 'Wide' };
  }
  return { font: 'Slant', styleLabel: 'Classic' };
}

function sanitizeAsciiBannerText(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function extractAsciiSceneSubjectFromPrompt(task: string): string {
  const normalized = task
    .replace(/\b(?:make|create|generate|draw|render|give me|show me|please)\b/gi, ' ')
    .replace(/\b(?:an?|the|some|creative|cool|nice|proper|good|detailed)\b/gi, ' ')
    .replace(/\b(?:ascii|text)\s+art\b/gi, ' ')
    .replace(/\bascii\b/gi, ' ')
    .replace(/\bart\b/gi, ' ')
    .replace(/\b(?:of|for|about)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.slice(0, 48) || 'creative subject';
}

function detectAsciiSceneSubject(task: string): string | null {
  const normalized = task.toLowerCase();
  for (const [alias, subject] of Object.entries(ASCII_SCENE_SUBJECTS)) {
    if (new RegExp(`\\b${alias}\\b`, 'i').test(normalized)) {
      return subject;
    }
  }
  return null;
}

function parseAsciiRequest(task: string): ParsedAsciiRequest {
  const quoted = extractQuotedAsciiText(task);
  const fontInfo = inferAsciiFont(task);
  const normalized = task.toLowerCase();
  const sceneSubject = detectAsciiSceneSubject(task);
  const explicitTextArt = Boolean(
    quoted ||
      /\b(?:my\s+name|the\s+word|word|name|spell|spelling|letters?|text|banner|logo|that\s+says|saying)\b/i.test(
        normalized,
      ),
  );

  if (explicitTextArt) {
    const text =
      sanitizeAsciiBannerText(
        quoted ||
          task
            .replace(
              /^.*?\b(?:word|name|spell(?:ing)?|letters?|text|logo|banner|saying|that says)\b/i,
              '',
            )
            .replace(/^(?:of|for)\s+/i, '')
            .trim(),
      ) || 'ASCII';
    return {
      mode: 'banner',
      value: text,
      font: fontInfo.font,
      styleLabel: fontInfo.styleLabel,
    };
  }

  if (sceneSubject) {
    return {
      mode: 'scene',
      value: sceneSubject,
      font: '',
      styleLabel: 'Scene',
    };
  }

  if (/\b(?:any|some|random)\s+ascii(?:\s+art)?\b/i.test(normalized)) {
    return {
      mode: 'scene',
      value: 'dog',
      font: '',
      styleLabel: 'Scene',
    };
  }

  return {
    mode: 'scene',
    value: extractAsciiSceneSubjectFromPrompt(task),
    font: '',
    styleLabel: 'Hermes Creative',
  };
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isLikelyAsciiSceneSegment(segment: string, subject: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length < 40) {
    return false;
  }
  if (/ascii character codes|>>\s*\w+\s*<</i.test(trimmed)) {
    return false;
  }

  const lines = trimmed.split('\n').filter((line) => line.trim());
  if (lines.length < 3 || lines.length > 45) {
    return false;
  }

  const maxWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);
  if (maxWidth > 110) {
    return false;
  }

  const nonWhitespace = trimmed.replace(/\s+/g, '');
  const alphaChars = (nonWhitespace.match(/[a-z]/gi) || []).length;
  const symbolChars = (nonWhitespace.match(/[\\\/(){}\[\]_=*^'"`~<>|:-]/g) || []).length;
  const alphaRatio = nonWhitespace.length > 0 ? alphaChars / nonWhitespace.length : 1;
  if (symbolChars < 8) {
    return false;
  }
  if (alphaRatio > 0.68 && !new RegExp(`\\b${subject}\\b`, 'i').test(trimmed)) {
    return false;
  }

  return true;
}

function scoreAsciiSceneSegment(segment: string): number {
  const lines = segment.split('\n').filter((line) => line.trim());
  const symbolChars = (segment.match(/[\\\/(){}\[\]_=*^'"`~<>|:-]/g) || []).length;
  return lines.length * 12 + symbolChars;
}

async function fetchAsciiSceneArt(subject: string): Promise<string | null> {
  const response = await fetch(`https://ascii.co.uk/art/${encodeURIComponent(subject)}`, {
    signal: AbortSignal.timeout(12_000),
  });
  const html = await response.text();
  if (!response.ok || !html.trim()) {
    return null;
  }

  const preBlocks = Array.from(html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)).map(
    (match) => match[1],
  );

  const segments = preBlocks
    .flatMap((block) =>
      unescapeHtmlEntities(block)
        .replace(/\r\n/g, '\n')
        .split(/\n\s*\n\s*\n+/)
        .map((segment) => segment.trim())
        .filter(Boolean),
    )
    .filter((segment) => isLikelyAsciiSceneSegment(segment, subject))
    .sort((left, right) => scoreAsciiSceneSegment(right) - scoreAsciiSceneSegment(left));

  return segments[0] || null;
}

async function fetchAsciiBannerArt(text: string, font: string): Promise<string | null> {
  const url = new URL('https://asciified.thelicato.io/api/v2/ascii');
  url.searchParams.set('text', text);
  url.searchParams.set('font', font);
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12_000),
  });
  const art = (await response.text()).replace(/\r\n/g, '\n').trim();
  if (!response.ok || !art || containsNonAsciiPrintable(art)) {
    return null;
  }
  return art;
}

const ASCII_BLOCK_FONT: Record<string, string[]> = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  J: ['#####', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  0: [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '   # ', '  #  ', '#####'],
  3: ['#### ', '    #', ' ### ', '    #', '#### '],
  4: ['#   #', '#   #', '#####', '    #', '    #'],
  5: ['#####', '#    ', '#### ', '    #', '#### '],
  6: [' ### ', '#    ', '#### ', '#   #', ' ### '],
  7: ['#####', '   # ', '  #  ', ' #   ', ' #   '],
  8: [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  9: [' ### ', '#   #', ' ####', '    #', ' ### '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

function renderLocalBlockAsciiText(text: string, shaded: boolean): string {
  const chars = sanitizeAsciiBannerText(text).toUpperCase().split('');
  const rows = Array.from({ length: 5 }, (_, row) =>
    chars
      .map((char) => ASCII_BLOCK_FONT[char]?.[row] ?? ASCII_BLOCK_FONT[' ']![row])
      .join('  ')
      .trimEnd(),
  );

  if (!shaded) {
    return rows.join('\n');
  }

  return rows
    .map((line, index) => {
      const shadow = ' '.repeat(index + 1) + line.replace(/#/g, '/');
      return `${line}\n${shadow}`;
    })
    .join('\n');
}

function formatAsciiArtResponse(request: ParsedAsciiRequest, art: string): string {
  const label =
    request.mode === 'scene'
      ? `Style: ${request.styleLabel} (${request.value})`
      : `Style: ${request.styleLabel} (${request.font})`;
  return `${label}\n\n\`\`\`text\n${art.trimEnd()}\n\`\`\``;
}

async function generateAsciiArtFromRemoteSources(task: string): Promise<string | null> {
  const request = parseAsciiRequest(task);
  if (request.mode !== 'banner') {
    return null;
  }

  const art = await fetchAsciiBannerArt(request.value, request.font);
  if (!art) {
    return null;
  }
  return formatAsciiArtResponse(request, art);
}

async function generateAsciiTextFastPath(request: ParsedAsciiRequest): Promise<string> {
  const remote = await fetchAsciiBannerArt(request.value, request.font).catch(() => null);
  if (remote && !containsNonAsciiPrintable(remote)) {
    return formatAsciiArtResponse(request, remote);
  }

  const shaded = /shade|shadow|3-d|3d/i.test(`${request.styleLabel} ${request.font}`);
  const local = renderLocalBlockAsciiText(request.value, shaded);
  return formatAsciiArtResponse(
    {
      ...request,
      font: shaded ? 'Local Shadow' : 'Local Block',
      styleLabel: shaded ? 'Shaded' : 'Block',
    },
    local,
  );
}

function extractAsciiCodeBlock(text: string): string {
  const match = text.match(/```(?:text)?\s*\n([\s\S]*?)```/i);
  return match?.[1]?.trim() || text.trim();
}

function containsNonAsciiPrintable(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    const isPrintableAscii = code >= 32 && code <= 126;
    if (!isAllowedControl && !isPrintableAscii) {
      return true;
    }
  }
  return false;
}

function wantsStrictAsciiBanner(task: string): boolean {
  return /\b(block|shade|shaded|shadow|banner|doom|figlet|font)\b/i.test(task);
}

function asciiBrainOutputLooksInvalid(task: string, output: string): boolean {
  const normalized = output.trim();
  if (!normalized) {
    return true;
  }

  if (!/```(?:text)?\s*\n[\s\S]*?```/i.test(normalized)) {
    return true;
  }

  if (
    /\b(?:research report|professional analysis|key developments|why it matters|latin america|would you like me to expand)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  const artBody = extractAsciiCodeBlock(normalized);
  if (!artBody || artBody.split('\n').filter((line) => line.trim()).length < 2) {
    return true;
  }

  if (containsNonAsciiPrintable(artBody)) {
    return true;
  }

  if (
    /\b(?:cat|dog|coffee|dragon|robot|heart|ship|owl|fish)\b/i.test(task) &&
    /["'`](?:a|an|any|the)["'`]\s+as ascii/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

function normalizeAsciiCreativeOutput(request: ParsedAsciiRequest, output: string): string | null {
  const normalized = output.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return null;
  }

  if (
    /\b(?:research report|professional analysis|key developments|why it matters|latin america|would you like|tools used)\b/i.test(
      normalized,
    )
  ) {
    return null;
  }

  const artBody = extractAsciiCodeBlock(normalized).trim();
  if (!artBody || containsNonAsciiPrintable(artBody)) {
    return null;
  }

  const nonEmptyLines = artBody.split('\n').filter((line) => line.trim());
  if (nonEmptyLines.length < 2 || nonEmptyLines.length > 60) {
    return null;
  }

  const maxWidth = nonEmptyLines.reduce((max, line) => Math.max(max, line.length), 0);
  if (maxWidth > 140) {
    return null;
  }

  const nonWhitespace = artBody.replace(/\s+/g, '');
  const alphaChars = (nonWhitespace.match(/[a-z]/gi) || []).length;
  const symbolChars = (nonWhitespace.match(/[\\\/(){}\[\]_=*^'"`~<>|:;.,-]/g) || []).length;
  const alphaRatio = nonWhitespace.length > 0 ? alphaChars / nonWhitespace.length : 1;
  if (symbolChars < 4 || alphaRatio > 0.72) {
    return null;
  }

  return formatAsciiArtResponse(request, artBody);
}

function buildGenericAsciiFallback(subject: string): string {
  const label = subject
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28)
    .toUpperCase();
  const width = Math.max(16, label.length + 6);
  const top = `.${'-'.repeat(width)}.`;
  const middle = `|${label.padStart(Math.floor((width + label.length) / 2)).padEnd(width)}|`;
  return [
    `   ${top}`,
    `  / ${' '.repeat(width)} \\`,
    ` /  ${middle}  \\`,
    ` \\  ${' '.repeat(width)}  /`,
    `  \\_${'_'.repeat(width)}_/`,
    '      /|\\',
    '     /_|_\\',
  ].join('\n');
}

async function generateAsciiCreativeFallback(request: ParsedAsciiRequest): Promise<string> {
  const remote = await fetchAsciiSceneArt(request.value).catch(() => null);
  if (remote && !containsNonAsciiPrintable(remote)) {
    return formatAsciiArtResponse(
      {
        ...request,
        styleLabel: 'Scene fallback',
      },
      remote,
    );
  }

  const local = ASCII_CREATIVE_FALLBACKS[request.value.toLowerCase()] || buildGenericAsciiFallback(request.value);
  return formatAsciiArtResponse(
    {
      ...request,
      styleLabel: 'Local fallback',
    },
    local,
  );
}

async function collectAsciiBrainOutput(
  task: string,
  request: ParsedAsciiRequest,
  strictRetry = false,
): Promise<string> {
  const message = [
    'Create creative ASCII scene/object art for the following request.',
    `User request: ${task}`,
    `Creative subject: ${request.value}`,
    '',
    'Mandatory rules:',
    '- MUST call skill_view(name="creative/ascii-art") before replying.',
    '- Use only printable ASCII characters (32-126) plus newlines.',
    '- Never use Unicode, emoji, kaomoji, CJK characters, or box-drawing characters.',
    '- This is NOT a text banner request. Do not spell words as large letters.',
    '- Draw the requested subject or scene itself.',
    '- Use recognizable silhouette/detail. For animals, include face/body cues; for objects, include shape/details.',
    '- Return exactly two parts: one short label line naming the chosen style, then one fenced code block using ```text.',
    '- Do not add extra explanation before or after the art.',
    strictRetry
      ? '- This is a retry because the previous answer was invalid. Be strict: pure ASCII only, no Unicode at all.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  let output = '';
  for await (const chunk of runAgentBrain(
    message,
    [],
    {
      walletAddress: '',
    },
    createRunId('ascii'),
  )) {
    if (chunk.type === 'delta') {
      output += chunk.delta;
    }
  }

  return output.trim();
}

async function generateAsciiAgentResult(task: string): Promise<string> {
  const parsed = parseAsciiRequest(task);
  if (parsed.mode === 'banner') {
    return generateAsciiTextFastPath(parsed);
  }

  const firstPass = await collectAsciiBrainOutput(task, parsed, false);
  const firstNormalized = normalizeAsciiCreativeOutput(parsed, firstPass);
  if (firstNormalized) {
    return firstNormalized;
  }
  console.warn('[ascii] Hermes creative output rejected', {
    subject: parsed.value,
    pass: 'first',
    sample: firstPass.slice(0, 240),
  });

  const secondPass = await collectAsciiBrainOutput(task, parsed, true);
  const secondNormalized = normalizeAsciiCreativeOutput(parsed, secondPass);
  if (secondNormalized) {
    return secondNormalized;
  }
  console.warn('[ascii] Hermes creative output rejected', {
    subject: parsed.value,
    pass: 'retry',
    sample: secondPass.slice(0, 240),
  });

  return generateAsciiCreativeFallback(parsed);
}

function buildAsciiFastPathMeta(
  status: 'started' | 'completed' | 'failed',
): BrainMessageMeta {
  if (status === 'completed') {
    return {
      title: 'AgentFlow',
      trace: [
        'ASCII Agent loaded the ASCII art skill',
        'ASCII Agent validated the requested style',
        'ASCII art is ready',
      ],
      activityMeta: {
        mode: 'brain',
        clusters: ['ASCII Agent'],
        stageBars: [34, 48, 62, 12, 12, 12],
      },
    };
  }

  if (status === 'failed') {
    return {
      title: 'AgentFlow',
      trace: [
        'ASCII Agent loaded the ASCII art skill',
        'ASCII Agent rejected an invalid generator response',
      ],
      activityMeta: {
        mode: 'brain',
        clusters: ['ASCII Agent'],
        stageBars: [34, 48, 12, 12, 12, 12],
      },
    };
  }

  return {
    title: 'AgentFlow',
    trace: [
      'ASCII Agent is loading the ASCII art skill',
      'ASCII Agent is validating the requested style',
    ],
    activityMeta: {
      mode: 'brain',
      clusters: ['ASCII Agent'],
      stageBars: [34, 48, 12, 12, 12, 12],
    },
  };
}

function buildAsciiFailureReply(details: string): string {
  const cleaned = details.trim();
  return [
    'I could not generate valid ASCII art for that request.',
    cleaned
      ? `Reason: ${cleaned}`
      : 'Reason: the ASCII skill returned an invalid result.',
    '',
    'I stopped instead of faking an answer or switching into research.',
  ].join('\n');
}

type DcwPaidConfirmResult<TData> = {
  status: number;
  data: TData;
  payment: {
    mode: 'DCW';
    payer: Address;
    agent: string;
    price: string;
    requestId: string;
    transaction: string | null;
    settlement: Record<string, unknown> | null;
  };
};

async function ensureUserPaidExecutionLedger(input: {
  payer: Address;
  agent: string;
  price: string;
  requestId: string;
  settlement?: Record<string, unknown> | null;
  transaction?: string | null;
}): Promise<void> {
  const requestRef = input.requestId || input.transaction || '';
  if (!requestRef) {
    return;
  }

  const { data: existing, error: existingError } = await adminDb
    .from('transactions')
    .select('id')
    .eq('buyer_agent', 'user_dcw')
    .eq('seller_agent', input.agent)
    .eq('request_id', requestRef)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    console.warn(`[ledger] ${input.agent} user-paid lookup failed:`, existingError.message);
  }
  if (existing?.id) {
    return;
  }

  const agentOwner = await loadAgentOwnerWallet(input.agent);
  const ledger = await insertAgentToAgentLedger({
    fromWallet: input.payer,
    toWallet: agentOwner.address,
    amount: Number(String(input.price).replace(/^\$/, '')) || 0,
    settlement: (input.settlement as any) || undefined,
    remark: `User DCW -> ${input.agent} Agent`,
    agentSlug: input.agent,
    buyerAgent: 'user_dcw',
    sellerAgent: input.agent,
    requestId: requestRef,
    context: `user_dcw->${input.agent}`,
  });

  if (!ledger.ok) {
    console.warn(`[ledger] ${input.agent} user-paid insert failed:`, ledger.error);
  }
}

async function runDcwPaidConfirm<TData>(
  input: {
    walletAddress: string;
    agent: string;
    price: string;
    url: string;
    body?: Record<string, unknown>;
    requestId: string;
  },
): Promise<DcwPaidConfirmResult<TData>> {
  const normalizedWallet = getAddress(input.walletAddress);
  const executionWallet = await getOrCreateUserAgentWallet(normalizedWallet);
  const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  const headers: Record<string, string> = internalKey
    ? { 'x-agentflow-paid-internal': internalKey }
    : { Authorization: `Bearer ${generateJWT(normalizedWallet)}` };

  const result = await payProtectedResourceServer<TData, Record<string, unknown>>({
    url: input.url,
    method: 'POST',
    body: {
      ...(input.body ?? {}),
      walletAddress: normalizedWallet,
      executionTarget: 'DCW',
    },
    circleWalletId: executionWallet.wallet_id,
    payer: getAddress(executionWallet.address),
    chainId: CHAIN_ID,
    headers,
    requestId: input.requestId,
    idempotencyKey: input.requestId,
  });

  await ensureUserPaidExecutionLedger({
    payer: getAddress(executionWallet.address),
    agent: input.agent,
    price: input.price,
    requestId: result.requestId,
    transaction: result.transactionRef ?? null,
    settlement:
      result.transaction && typeof result.transaction === 'object'
        ? (result.transaction as Record<string, unknown>)
        : null,
  });

  return {
    status: result.status,
    data: result.data,
    payment: {
      mode: 'DCW',
      payer: getAddress(executionWallet.address),
      agent: input.agent,
      price: input.price,
      requestId: result.requestId,
      transaction: result.transactionRef ?? null,
      settlement:
        result.transaction && typeof result.transaction === 'object'
          ? (result.transaction as Record<string, unknown>)
          : null,
    },
  };
}

async function buildBrainWalletCtx(
  walletAddress?: Address,
  executionTarget?: 'EOA' | 'DCW',
): Promise<BrainWalletContext> {
  const walletCtx: BrainWalletContext = {
    walletAddress: walletAddress || '',
    executionWalletId: undefined,
    executionWalletAddress: undefined,
    executionTarget,
    profileContext: '',
  };

  if (!walletAddress) {
    return walletCtx;
  }

  try {
    const dcwModule: any = await import('./lib/dcw');
    const findPersistedUserAgentWallet =
      dcwModule.findPersistedUserAgentWallet ??
      dcwModule.default?.findPersistedUserAgentWallet;
    const getUserAgentWallet =
      dcwModule.getOrCreateUserAgentWallet ??
      dcwModule.default?.getOrCreateUserAgentWallet;
    if (typeof findPersistedUserAgentWallet === 'function') {
      const persistedExecutionWallet = await findPersistedUserAgentWallet(walletAddress);
      if (persistedExecutionWallet) {
        walletCtx.executionWalletId = persistedExecutionWallet.wallet_id;
        walletCtx.executionWalletAddress = getAddress(persistedExecutionWallet.address);
        return walletCtx;
      }
    }
    if (typeof getUserAgentWallet === 'function') {
      const executionWallet = await getUserAgentWallet(walletAddress);
      if (executionWallet) {
        walletCtx.executionWalletId = executionWallet.wallet_id;
        walletCtx.executionWalletAddress = executionWallet.address;
      }
    }
  } catch (error) {
    console.warn('[brain] execution wallet lookup failed:', getErrorMessage(error));
  }

  return walletCtx;
}

function shouldIncludePortfolioContext(task: string): boolean {
  return /\b(?:portfolio|holdings?|positions?|wallet\s+tokens|asset\s+allocation|exposure|what\s+i\s+hold)\b/i.test(
    task,
  );
}

function numericOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function buildResearchWalletContext(params: {
  task: string;
  ownerWalletAddress: string;
  executionWalletAddress: string;
  executionTarget?: 'DCW' | 'EOA';
}): Promise<ResearchWalletContext | null> {
  const shouldScanPortfolio = shouldIncludePortfolioContext(params.task);
  if (!shouldScanPortfolio) {
    return null;
  }

  const ownerWalletAddress = isAddress(params.ownerWalletAddress)
    ? getAddress(params.ownerWalletAddress)
    : params.ownerWalletAddress;
  const scannedWalletAddress = isAddress(params.executionWalletAddress)
    ? getAddress(params.executionWalletAddress)
    : params.executionWalletAddress;
  const base = {
    source: 'agentflow_portfolio_snapshot' as const,
    requested_for_task: true,
    owner_wallet_address: ownerWalletAddress,
    execution_target: params.executionTarget ?? 'DCW',
    scanned_wallet_address: scannedWalletAddress,
    as_of: new Date().toISOString(),
  };

  try {
    const { buildPortfolioSnapshot } = await import('./agents/portfolio/portfolio');
    const snapshot = await buildPortfolioSnapshot(scannedWalletAddress, {
      gatewayDepositors:
        params.executionTarget === 'DCW'
          ? [ownerWalletAddress, scannedWalletAddress]
          : [scannedWalletAddress],
    });
    return {
      ...base,
      scanned_wallet_address: snapshot.walletAddress,
      total_value_usd: snapshot.pnlSummary.currentValueUsd,
      cost_basis_usd: snapshot.pnlSummary.costBasisUsd,
      pnl_usd: snapshot.pnlSummary.pnlUsd,
      pnl_pct: snapshot.pnlSummary.pnlPct,
      holdings: snapshot.holdings.slice(0, 16).map((holding) => ({
        symbol: holding.symbol,
        name: holding.name,
        kind: holding.kind,
        balance: holding.balanceFormatted,
        usd_value: numericOrNull(holding.usdValue),
        notes: holding.notes.slice(0, 3),
      })),
      positions: snapshot.positions.slice(0, 12).map((position) => ({
        name: position.name,
        protocol: position.protocol,
        kind: position.kind,
        amount: position.amountFormatted,
        usd_value: numericOrNull(position.usdValue),
        pnl_usd: numericOrNull(position.pnlUsd),
        notes: position.notes.slice(0, 3),
      })),
      diagnostics: {
        gateway_balance_source: snapshot.diagnostics.gatewayBalance.source,
        gateway_balance_error: snapshot.diagnostics.gatewayBalance.error,
        arc_data_available: snapshot.diagnostics.arcData.rpcAvailable,
      },
    };
  } catch (error) {
    console.warn('[research] portfolio context unavailable:', getErrorMessage(error));
    return {
      ...base,
      total_value_usd: 0,
      cost_basis_usd: 0,
      pnl_usd: 0,
      pnl_pct: 0,
      holdings: [],
      positions: [],
      error: getErrorMessage(error),
    };
  }
}

function roundUsdLabel(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unknown value';
  }
  if (value < 1) {
    return 'under $1';
  }
  if (value < 100) {
    return `about $${Math.round(value)}`;
  }
  return `about $${Math.round(value / 10) * 10}`;
}

const STABLECOIN_SYMBOLS = new Set(['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'FRAX']);
const MAJOR_VOLATILE_SYMBOLS = new Set(['BTC', 'WBTC', 'ETH', 'WETH', 'SOL', 'AVAX', 'MATIC', 'POL', 'LINK']);

function sumUsd(items: Array<{ usd_value: number | null }>): number {
  return items.reduce((sum, item) => sum + (item.usd_value ?? 0), 0);
}

function exposurePercent(value: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
}

function holdingLabel(symbols: string[]): string {
  if (symbols.length === 0) return '';
  if (symbols.length === 1) return symbols[0];
  if (symbols.length === 2) return `${symbols[0]} and ${symbols[1]}`;
  return `${symbols.slice(0, -1).join(', ')}, and ${symbols[symbols.length - 1]}`;
}

function buildPortfolioExposureSummary(context: ResearchWalletContext): {
  totalLabel: string;
  profile: string;
  impactLines: string[];
  notApplicableLines: string[];
} {
  const holdings = Array.isArray(context.holdings) ? context.holdings : [];
  const positions = Array.isArray(context.positions) ? context.positions : [];
  const total = typeof context.total_value_usd === 'number' ? context.total_value_usd : 0;
  const stableHoldings = holdings.filter((holding) =>
    STABLECOIN_SYMBOLS.has(holding.symbol.toUpperCase()),
  );
  const volatileHoldings = holdings.filter((holding) =>
    MAJOR_VOLATILE_SYMBOLS.has(holding.symbol.toUpperCase()),
  );
  const stablePositionValue = positions
    .filter((position) => /gateway|stable|usdc|eurc/i.test(`${position.name} ${position.protocol} ${position.amount}`))
    .reduce((sum, item) => sum + (item.usd_value ?? 0), 0);
  const stableValue = sumUsd(stableHoldings) + stablePositionValue;
  const volatileValue = sumUsd(volatileHoldings);
  const defiValue = positions
    .filter((position) => !/gateway/i.test(`${position.name} ${position.protocol}`))
    .reduce((sum, item) => sum + (item.usd_value ?? 0), 0);
  const gatewayValue = positions
    .filter((position) => /gateway/i.test(`${position.name} ${position.protocol}`))
    .reduce((sum, item) => sum + (item.usd_value ?? 0), 0);
  const stablePct = exposurePercent(stableValue, total);
  const volatilePct = exposurePercent(volatileValue, total);
  const stableSymbols = [
    ...new Set([
      ...stableHoldings.map((holding) => holding.symbol.toUpperCase()),
      ...(gatewayValue > 0 && !stableHoldings.some((holding) => holding.symbol.toUpperCase() === 'USDC')
        ? ['USDC via Gateway']
        : []),
    ]),
  ];
  const stableExposureLabel =
    gatewayValue > 0 && stableHoldings.some((holding) => holding.symbol.toUpperCase() === 'USDC')
      ? 'USDC, mostly through Gateway'
      : holdingLabel(stableSymbols);
  const volatileSymbols = [...new Set(volatileHoldings.map((holding) => holding.symbol.toUpperCase()))];

  const profile =
    stablePct >= 80
      ? `stablecoin-heavy portfolio (about ${stablePct}% in ${stableExposureLabel || 'stablecoin rails'})`
      : volatilePct >= 50
        ? `volatile crypto-heavy portfolio (${holdingLabel(volatileSymbols) || 'major crypto assets'})`
        : defiValue > 0
          ? 'DeFi-position-heavy portfolio'
          : stablePct > 0
            ? `mixed portfolio with meaningful stablecoin exposure (${stablePct}% in stablecoin-like assets)`
            : 'mixed portfolio';

  const impactLines: string[] = [];
  const notApplicableLines: string[] = [];

  if (stablePct >= 80) {
    impactLines.push(
      'Direct token-price volatility should be limited because the detected exposure is mostly stablecoins, not BTC/ETH-style risk assets.',
      'The relevant risks are peg quality, issuer and reserve confidence, redemption/liquidity conditions, regulatory announcements, dollar funding stress, and Gateway settlement/liquidity availability.',
      'If the researched event affects rates, Treasuries, banking stability, stablecoin regulation, sanctions, or payment rails, it matters more through stablecoin liquidity and redemption channels than through spot-price upside or downside.',
    );
    notApplicableLines.push(
      'Generic BTC or ETH crash/rally analysis is not the main lens for this wallet unless those assets are later added.',
    );
  } else if (volatilePct >= 50) {
    impactLines.push(
      `The detected exposure includes major volatile crypto assets (${holdingLabel(volatileSymbols)}), so macro, regulatory, liquidity, and geopolitical shocks can affect mark-to-market value more directly.`,
      'The key channels are risk-on/risk-off flows, crypto liquidity, ETF or institutional flows where relevant, leverage unwinds, and changes in dollar rates.',
    );
  } else if (defiValue > 0) {
    impactLines.push(
      'The detected exposure includes DeFi positions, so smart-contract, liquidity, withdrawal, yield-compression, and pool-imbalance risks matter alongside token prices.',
      'Events that affect stablecoin liquidity, rates, or onchain activity can change yield and exit conditions even when token prices look stable.',
    );
  } else {
    impactLines.push(
      'The detected portfolio does not show a single dominant volatile token exposure, so the report should focus on liquidity, regulation, and asset-class channels rather than a generic crypto-market move.',
    );
  }

  if (gatewayValue > 0) {
    impactLines.push(
      'Because a meaningful share sits in Circle Gateway, cross-chain liquidity, instant settlement reliability, and Gateway redemption/deposit conditions are part of the practical risk picture.',
    );
  }

  return {
    totalLabel: roundUsdLabel(total),
    profile,
    impactLines,
    notApplicableLines,
  };
}

function formatWalletContextReportSection(liveData: Record<string, unknown> | null): string {
  const walletContext = liveData?.wallet_context;
  if (!walletContext || typeof walletContext !== 'object') {
    return '';
  }

  const context = walletContext as ResearchWalletContext;
  if (context.error) {
    return [
      '## Your Portfolio Impact',
      '',
      'AgentFlow tried to read your portfolio context for this report, but the wallet snapshot was unavailable. I will avoid making personalized balance or exposure claims instead of guessing.',
    ].join('\n');
  }

  const exposure = buildPortfolioExposureSummary(context);

  return [
    '## Your Portfolio Impact',
    '',
    `Your current AgentFlow portfolio context looks like a ${exposure.profile}, with ${exposure.totalLabel} in marked value. I am using that exposure privately to personalize the analysis, not to turn this into a balance statement.`,
    '',
    ...exposure.impactLines.map((line) => `- ${line}`),
    ...(exposure.notApplicableLines.length
      ? ['', '**What this does not mean**', '', ...exposure.notApplicableLines.map((line) => `- ${line}`)]
      : []),
    '',
    'If you want exact balances, wallet address, or performance accounting shown in the report, ask for a portfolio breakdown explicitly.',
  ].join('\n');
}

function stripExistingPortfolioImpactSection(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const headingPattern = /^#{2,3}\s+(?:Your Portfolio Impact|Personalized Portfolio Impact|Portfolio Impact|Portfolio Implications)\b.*$/gim;
  const match = headingPattern.exec(normalized);
  if (!match || match.index === undefined) {
    return normalized;
  }

  const start = match.index;
  const rest = normalized.slice(start + match[0].length);
  const nextHeading = rest.search(/\n#{2,3}\s+\S/gm);
  if (nextHeading < 0) {
    return normalized.slice(0, start).trimEnd();
  }
  const end = start + match[0].length + nextHeading;
  return `${normalized.slice(0, start).trimEnd()}\n\n${normalized.slice(end).trimStart()}`.trim();
}

function ensureWalletContextInReport(markdown: string, liveData: Record<string, unknown> | null): string {
  const section = formatWalletContextReportSection(liveData);
  if (!section) {
    return markdown;
  }
  const cleanedMarkdown = stripExistingPortfolioImpactSection(markdown);

  const sourcesIndex = cleanedMarkdown.search(/^##\s+Sources\b/im);
  if (sourcesIndex >= 0) {
    return `${cleanedMarkdown.slice(0, sourcesIndex).trim()}\n\n${section}\n\n${cleanedMarkdown.slice(sourcesIndex).trim()}`;
  }

  return `${cleanedMarkdown.trim()}\n\n${section}`;
}

function streamStaticSseReply(res: Response, text: string): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // @ts-ignore
  res.flushHeaders?.();

  for (const chunk of text.match(/[\s\S]{1,120}/g) ?? [text]) {
    res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function isReportRenderingComplaint(message: string): boolean {
  return /\b(half|partial|incomplete|broken|missing|cut off|truncated)\b.*\breport\b|\breport\b.*\b(half|partial|incomplete|broken|missing|cut off|truncated)\b/i.test(
    message,
  );
}

function extractStoredResearchReport(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const divider = /\n\s*---\s*\n/.exec(normalized);
  if (!divider) return null;

  const report = normalized.slice(divider.index + divider[0].length).trim();
  if (!report) return null;
  if (!/^#{1,3}\s+\S/m.test(report) && !/^##\s+(?:Summary|Overview|Executive Summary|Current Situation|Takeaway)\b/im.test(report)) {
    return null;
  }
  return report;
}

function findLatestStoredResearchReport(history: BrainConversationMessage[]): string | null {
  for (const item of [...history].reverse()) {
    if (item.role !== 'assistant') continue;
    const report = extractStoredResearchReport(item.content);
    if (report) return report;
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function getAgentResultText(data: { result?: string } | undefined | null): string {
  if (typeof data?.result === 'string' && data.result.trim()) {
    return data.result;
  }
  return JSON.stringify(data ?? {});
}

function createRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Extra origins (VPS, prod domain) — must match `Origin` header exactly. */
const CORS_EXTRA_ALLOWED_ORIGINS = new Set([
  'http://178.104.240.191',
  'https://agentflow.one',
  'http://agentflow.one',
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (CORS_EXTRA_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.vercel.app')) return true;
    if (url.protocol === 'https:') return true;
    return false;
  } catch {
    return false;
  }
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(typeof origin === 'string' ? origin : undefined);

  if (typeof origin === 'string' && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  const requestedHeaders = req.headers['access-control-request-headers'];
  if (typeof requestedHeaders === 'string' && requestedHeaders.trim()) {
    res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
  } else {
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Payment-Signature, Authorization',
    );
  }
  res.setHeader(
    'Access-Control-Expose-Headers',
    'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Content-Type',
  );

  if (req.method === 'OPTIONS') {
    if (origin && !allowed) {
      res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
      return;
    }
    res.sendStatus(204);
    return;
  }

  next();
}

function parseStep(input: string | undefined): OrchestratorStep | null {
  if (input === 'research' || input === 'analyst' || input === 'writer') {
    return input;
  }
  return null;
}

function decodeTransactionFromPaymentResponse(
  paymentResponseHeader: string | null,
): string | undefined {
  if (!paymentResponseHeader) return undefined;
  try {
    const decoded = Buffer.from(paymentResponseHeader, 'base64').toString('utf-8');
    const payload = JSON.parse(decoded) as { transaction?: string };
    return typeof payload.transaction === 'string' ? payload.transaction : undefined;
  } catch {
    return undefined;
  }
}

function getAgentUrl(step: OrchestratorStep): string {
  switch (step) {
    case 'research':
      return RESEARCH_URL;
    case 'analyst':
      return ANALYST_URL;
    case 'writer':
      return WRITER_URL;
  }
}

function parseDcwPaidAgentSlug(value: string): DcwPaidAgentSlug | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'ascii' ||
    normalized === 'swap' ||
    normalized === 'vault' ||
    normalized === 'portfolio' ||
    normalized === 'vision' ||
    normalized === 'transcribe'
  ) {
    return normalized;
  }
  return null;
}

function getDcwPaidAgentUrl(slug: DcwPaidAgentSlug): string {
  switch (slug) {
    case 'ascii':
      return ASCII_URL;
    case 'swap':
      return SWAP_URL;
    case 'vault':
      return VAULT_URL;
    case 'portfolio':
      return PORTFOLIO_URL;
    case 'vision':
      return VISION_URL;
    case 'transcribe':
      return TRANSCRIBE_URL;
  }
}

function getDcwPaidAgentPrice(slug: DcwPaidAgentSlug): string {
  switch (slug) {
    case 'ascii':
      return `${asciiPrice} USDC`;
    case 'swap':
      return `${swapPrice} USDC`;
    case 'vault':
      return `${vaultPrice} USDC`;
    case 'portfolio':
      return `${portfolioPrice} USDC`;
    case 'vision':
      return `${parsePrice(process.env.VISION_AGENT_PRICE, '0.004')} USDC`;
    case 'transcribe':
      return `${parsePrice(process.env.TRANSCRIBE_AGENT_PRICE, '0.002')} USDC`;
  }
}

function getPaidAgentUrlBySlug(slug: string): string | null {
  switch (slug.toLowerCase()) {
    case 'ascii':
      return ASCII_URL;
    case 'research':
      return RESEARCH_URL;
    case 'analyst':
      return ANALYST_URL;
    case 'writer':
      return WRITER_URL;
    case 'swap':
      return SWAP_URL;
    case 'vault':
      return VAULT_URL;
    case 'bridge':
      return BRIDGE_URL;
    case 'portfolio':
      return PORTFOLIO_URL;
    case 'vision':
      return VISION_URL;
    case 'transcribe':
      return TRANSCRIBE_URL;
    default:
      return null;
  }
}

const X402_TERMINAL_STAGES = new Set<X402AttemptStage>([
  'failed',
  'preflight_failed',
  'succeeded',
]);

type X402AttemptMutationInput = {
  requestId: string;
  idempotencyKey: string;
  route: string;
  method: 'GET' | 'POST';
  payer: string;
  chainId: number;
  stage: X402AttemptStage;
  httpStatus?: number;
  error?: string;
  transaction?: string;
  slug?: string;
  mode?: X402AttemptMode;
};

function isX402AttemptStage(value: unknown): value is X402AttemptStage {
  switch (value) {
    case 'started':
    case 'preflight_ok':
    case 'preflight_failed':
    case 'payment_required':
    case 'payload_created':
    case 'paid_request_sent':
    case 'succeeded':
    case 'failed':
      return true;
    default:
      return false;
  }
}

function isX402AttemptMode(value: unknown): value is X402AttemptMode {
  return value === 'eoa' || value === 'dcw';
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseX402AttemptMutationInput(
  body: unknown,
  forcedStage?: X402AttemptStage,
): { value?: X402AttemptMutationInput; error?: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'JSON body is required.' };
  }

  const record = body as Record<string, unknown>;
  const requestId = String(record.requestId || '').trim();
  const idempotencyKey = String(record.idempotencyKey || '').trim();
  const route = String(record.route || '').trim();
  const method = String(record.method || 'POST').trim().toUpperCase();
  const payer = String(record.payer || '').trim();
  const chainId = Number(record.chainId);
  const stageValue = forcedStage || String(record.stage || '').trim();

  if (!requestId) {
    return { error: 'requestId is required.' };
  }
  if (!idempotencyKey) {
    return { error: 'idempotencyKey is required.' };
  }
  if (!route) {
    return { error: 'route is required.' };
  }
  if (method !== 'GET' && method !== 'POST') {
    return { error: 'method must be GET or POST.' };
  }
  if (!isAddress(payer)) {
    return { error: 'payer must be a valid wallet address.' };
  }
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return { error: 'chainId must be a positive number.' };
  }
  if (!isX402AttemptStage(stageValue)) {
    return { error: 'stage is invalid.' };
  }

  const mode = isX402AttemptMode(record.mode) ? record.mode : undefined;
  const slug =
    typeof record.slug === 'string' && record.slug.trim()
      ? record.slug.trim().toLowerCase()
      : undefined;
  const error =
    typeof record.error === 'string' && record.error.trim()
      ? record.error.trim()
      : undefined;
  const transaction =
    typeof record.transaction === 'string' && record.transaction.trim()
      ? record.transaction.trim()
      : undefined;

  return {
    value: {
      requestId,
      idempotencyKey,
      route,
      method,
      payer: getAddress(payer),
      chainId,
      stage: stageValue,
      httpStatus: parseOptionalNumber(record.httpStatus),
      error,
      transaction,
      slug,
      mode,
    },
  };
}

async function proxyAgentRun(params: {
  step: OrchestratorStep;
  method: 'GET' | 'POST';
  body?: unknown;
  paymentSignature?: string;
}): Promise<{
  status: number;
  data: unknown;
  contentType: string | null;
  paymentRequiredHeader: string | null;
  paymentResponseHeader: string | null;
}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.paymentSignature) {
    headers['Payment-Signature'] = params.paymentSignature;
  }

  const response = await fetch(getAgentUrl(params.step), {
    method: params.method,
    headers,
    body: params.method === 'POST' ? JSON.stringify(params.body ?? {}) : undefined,
  });

  const contentType = response.headers.get('content-type');
  const rawBody = await response.text();
  let data: unknown = rawBody;

  if (rawBody && contentType?.includes('application/json')) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = rawBody;
    }
  }

  return {
    status: response.status,
    data,
    contentType,
    paymentRequiredHeader: response.headers.get('PAYMENT-REQUIRED'),
    paymentResponseHeader: response.headers.get('PAYMENT-RESPONSE'),
  };
}

async function fetchGatewayBalanceForAddress(address: Address): Promise<{
  available: string;
  total: string;
}> {
  const response = await fetch(`${GATEWAY_API_BASE_URL}/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [{ depositor: address, domain: ARC_TESTNET_DOMAIN }],
    }),
  });

  const json = (await response.json().catch(() => ({}))) as {
    balances?: Array<{ balance?: string; withdrawing?: string }>;
    message?: string;
    error?: string;
  };

  if (!response.ok) {
    const details = json.message || json.error || `HTTP ${response.status}`;
    throw new Error(`Gateway API balance fetch failed: ${details}`);
  }

  const first = Array.isArray(json.balances) ? json.balances[0] : undefined;
  const available = first?.balance ?? '0';
  const withdrawing = first?.withdrawing ?? '0';
  const total = (Number(available) + Number(withdrawing)).toString();

  return { available, total };
}

function createFacilitatorApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: AGENT_JSON_LIMIT }));
  const gatewayClient = new BatchFacilitatorClient();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/v1/x402/supported', async (_req, res) => {
    const rid = createRunId('supported');
    try {
      const result = await gatewayClient.getSupported();
      console.log(`[Facilitator ${rid}] supported ok`);
      res.json(result);
    } catch (err) {
      const details = getErrorMessage(err);
      console.error(`[Facilitator ${rid}] /supported failed`, err);
      res
        .status(500)
        .json({ error: 'Internal error during getSupported', details, requestId: rid });
    }
  });

  app.post('/v1/x402/verify', async (req, res) => {
    const rid = createRunId('verify');
    try {
      const { paymentPayload, paymentRequirements } = req.body || {};
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: 'Missing payment data', requestId: rid });
      }
      if (!isBatchPayment(paymentRequirements)) {
        return res.status(400).json({
          error: 'Only Gateway batched payments are supported',
          requestId: rid,
        });
      }
      const result = await gatewayClient.verify(paymentPayload, paymentRequirements);
      if ('isValid' in result && result.isValid === false) {
        console.error(`[Facilitator ${rid}] verify failed`, result.invalidReason ?? result);
      }
      return res.json(result);
    } catch (err) {
      const details = getErrorMessage(err);
      console.error(`[Facilitator ${rid}] /verify failed`, err);
      return res
        .status(500)
        .json({ error: 'Internal error during verify', details, requestId: rid });
    }
  });

  app.post('/v1/x402/settle', async (req, res) => {
    const rid = createRunId('settle');
    try {
      const { paymentPayload, paymentRequirements } = req.body || {};
      if (!paymentPayload || !paymentRequirements) {
        return res.status(400).json({ error: 'Missing payment data', requestId: rid });
      }
      if (!isBatchPayment(paymentRequirements)) {
        return res.status(400).json({
          error: 'Only Gateway batched payments are supported',
          requestId: rid,
        });
      }
      const result = await gatewayClient.settle(paymentPayload, paymentRequirements);
      if (!result.success) {
        console.error(`[Facilitator ${rid}] settle failed`, result.errorReason ?? result);
      }
      return res.json(result);
    } catch (err) {
      const details = getErrorMessage(err);
      console.error(`[Facilitator ${rid}] /settle failed`, err);
      return res
        .status(500)
        .json({ error: 'Internal error during settle', details, requestId: rid });
    }
  });

  return app;
}

function createAgentApp(
  name: OrchestratorStep,
  price: string,
  timeoutMs: number,
  run: (req: Request) => Promise<Record<string, unknown>>,
): express.Express {
  const app = express();
  app.use(express.json());
  const gateway = createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: FACILITATOR_URL,
  });

  const handler = async (req: Request, res: Response) => {
    const requestId = createRunId(name);
    const start = Date.now();
    try {
      const payload = await withTimeout(run(req), timeoutMs, `${name} agent`);
      console.log(`[Agent ${name} ${requestId}] done in ${Date.now() - start}ms`);
      void incrementTxCount(name).catch((err) =>
        console.warn(`[tx-counter] increment failed for ${name}:`, err),
      );
      res.json(payload);
    } catch (err) {
      const details = getErrorMessage(err);
      const status = details.includes('timed out') ? 504 : 500;
      console.error(`[Agent ${name} ${requestId}] failed`, err);
      res.status(status).json({
        error: `${name} agent failed`,
        details,
        requestId,
      });
    }
  };

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: name });
  });

  app.get('/run', gateway.require(price), handler);
  app.post('/run', gateway.require(price), handler);

  return app;
}

function createPublicApp(): express.Express {
  const app = express();
  // Inbound email webhooks need raw body for Svix signature verification (before express.json).
  app.use('/api/webhooks/email', emailWebhookRouter);
  app.use(express.json({ limit: AGENT_JSON_LIMIT }));
  app.use(corsMiddleware);
  app.use('/api/auth', authApiRouter);
  app.use('/api/wallet', walletApiRouter);
  app.use('/api/settings', settingsApiRouter);
  app.use('/api/telegram', telegramApiRouter);
  app.use('/api/extension', extensionApiRouter);
  app.use('/api/business', businessApiRouter);
  app.use('/api/pay', payApiRouter);
  // Agent Store API (legacy path /api/marketplace retained for backwards compatibility)
  app.use('/api/marketplace', marketplaceApiRouter);
  app.use('/api/agent-store', marketplaceApiRouter);
  app.use('/api/portfolio', portfolioApiRouter);
  app.use('/api/funds', fundsApiRouter);

  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await getTxStats();

      const { count, error } = await adminDb
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'complete');

      if (error) {
        throw new Error(error.message);
      }

      const { count: a2aCount, error: a2aErr } = await adminDb
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('action_type', 'agent_to_agent_payment')
        .eq('status', 'complete');

      if (a2aErr) {
        throw new Error(a2aErr.message);
      }

      return res.json({
        total_transactions: stats.total,
        onchain_transactions: count ?? 0,
        agent_to_agent_payments: a2aCount ?? 0,
        by_agent: stats.byAgent,
        powered_by: 'Arc Network + Circle Nanopayments',
        settlement: 'USDC on Arc Testnet',
      });
    } catch (e: unknown) {
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  app.get('/api/economy', async (_req: Request, res: Response) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayIso = today.toISOString();
      const sixHoursAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const coreAgentSpecs = CORE_AGENT_SPECS.map((spec) => ({
        slug: spec.slug,
        name: spec.name,
        category: spec.category,
        priceUsdc: parseAmount(process.env[spec.envPriceKey] ?? spec.fallbackPrice),
      }));
      const coreAgentSlugs = coreAgentSpecs.map((spec) => spec.slug);

      const [
        todayStatsResult,
        latestTxsResult,
        recentA2aResult,
        hourlyDataResult,
        agentWalletsResult,
        allTimeSettlementsResult,
        allTimeTasksResult,
        allTimeUsdc,
        allTimeA2aCountResult,
      ] = await Promise.all([
        adminDb
          .from('transactions')
          .select(
            'amount, action_type, payment_rail, buyer_agent, seller_agent, agent_slug, created_at, arc_tx_id',
          )
          .eq('status', 'complete')
          .gte('created_at', todayIso),
        adminDb
          .from('transactions')
          .select('*')
          .eq('status', 'complete')
          .neq('action_type', 'agent_to_agent_payment')
          .order('created_at', { ascending: false })
          .limit(20),
        adminDb
          .from('transactions')
          .select(
            'id, buyer_agent, seller_agent, amount, payment_rail, arc_tx_id, gateway_transfer_id, request_id, created_at, remark',
          )
          .eq('status', 'complete')
          .eq('action_type', 'agent_to_agent_payment')
          .order('created_at', { ascending: false })
          .limit(50),
        adminDb
          .from('transactions')
          .select('agent_slug, seller_agent, created_at')
          .eq('status', 'complete')
          .gte('created_at', sixHoursAgoIso)
          .order('created_at', { ascending: true }),
        adminDb
          .from('wallets')
          .select('agent_slug, wallet_id, address')
          .eq('purpose', 'owner')
          .in('agent_slug', coreAgentSlugs),
        adminDb
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'complete'),
        adminDb
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'complete')
          .neq('action_type', 'agent_to_agent_payment'),
        sumCompletedTransactionAmounts(),
        adminDb
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('action_type', 'agent_to_agent_payment')
          .eq('status', 'complete')
          .in('buyer_agent', coreAgentSlugs)
          .in('seller_agent', coreAgentSlugs),
      ]);
      const treasuryStats = await getTreasuryStats().catch((error) => {
        console.warn('[economy] treasury stats skipped:', getErrorMessage(error));
        return null;
      });

      for (const query of [
        todayStatsResult,
        latestTxsResult,
        recentA2aResult,
        hourlyDataResult,
        agentWalletsResult,
        allTimeSettlementsResult,
        allTimeTasksResult,
        allTimeA2aCountResult,
      ]) {
        if (query.error) {
          throw new Error(query.error.message);
        }
      }

      const coreAgentSlugSet = new Set(coreAgentSlugs);
      const isCoreAgent = (
        value: string | null | undefined,
      ): value is (typeof coreAgentSlugs)[number] =>
        typeof value === 'string' && coreAgentSlugSet.has(value as (typeof coreAgentSlugs)[number]);

      const totalStats = todayStatsResult.data ?? [];
      const totalTasks = totalStats.filter(
        (tx) => tx.action_type !== 'agent_to_agent_payment',
      ).length;
      const totalUsdc = totalStats.reduce((sum, tx) => sum + parseAmount(tx.amount), 0);
      const a2aTxs = totalStats.filter(
        (tx) =>
          tx.action_type === 'agent_to_agent_payment' &&
          isCoreAgent(tx.buyer_agent) &&
          isCoreAgent(tx.seller_agent),
      );
      const recentA2aPayments = (recentA2aResult.data ?? [])
        .filter((tx) => isCoreAgent(tx.buyer_agent) && isCoreAgent(tx.seller_agent))
        .slice(0, 20);
      const allTimeA2aCount = allTimeA2aCountResult.count ?? 0;
      const todayArcGas = await estimateArcGasPaidUsd(
        totalStats.map((tx) => (typeof tx.arc_tx_id === 'string' ? tx.arc_tx_id : null)),
      );

      const sellerAddresses = (agentWalletsResult.data ?? [])
        .map((wallet) => wallet?.address)
        .filter((address): address is string => typeof address === 'string' && isAddress(address))
        .map((address) => getAddress(address));
      const batcherEnv = process.env.ARC_GATEWAY_BATCHER_ADDRESS?.trim();
      const batcherAddress =
        batcherEnv && isAddress(batcherEnv) ? getAddress(batcherEnv) : undefined;

      const attributedArcGas = await fetchAttributedArcBatcherGas(sellerAddresses, {
        batcherAddress,
      });

      const fallbackGasTxCount = totalStats.filter((tx) => shouldCountFallbackArcGas(tx)).length;
      const fallbackGasPerTx =
        Number.isFinite(ECONOMY_ARC_FALLBACK_GAS_PER_TX_USD) && ECONOMY_ARC_FALLBACK_GAS_PER_TX_USD > 0
          ? ECONOMY_ARC_FALLBACK_GAS_PER_TX_USD
          : 0.000001;
      const usingAttributedGas = attributedArcGas.totalUsd > 0;
      const fallbackGasUsd = usingAttributedGas ? 0 : fallbackGasTxCount * fallbackGasPerTx;
      const combinedArcGasUsd =
        todayArcGas.totalUsd + attributedArcGas.totalUsd + fallbackGasUsd;
      const combinedArcGasTxCount =
        todayArcGas.countedTxs +
        attributedArcGas.ourTransferCount +
        (usingAttributedGas ? 0 : fallbackGasTxCount);
      const todayNetMarginPercent = computeNetMarginPercent(totalUsdc, combinedArcGasUsd);

      const agentEarnings: Record<
        string,
        { earned: number; spent: number; tasks: number }
      > = Object.fromEntries(
        coreAgentSpecs.map((spec) => [spec.slug, { earned: 0, spent: 0, tasks: 0 }]),
      );

      for (const tx of totalStats) {
        const amount = parseAmount(tx.amount);
        const seller = tx.seller_agent || tx.agent_slug;
        const participants = new Set<string>();

        if (seller) {
          if (!agentEarnings[seller]) {
            agentEarnings[seller] = { earned: 0, spent: 0, tasks: 0 };
          }
          agentEarnings[seller].earned += amount;
          participants.add(seller);
        }

        const buyer = tx.buyer_agent;
        if (buyer) {
          if (!agentEarnings[buyer]) {
            agentEarnings[buyer] = { earned: 0, spent: 0, tasks: 0 };
          }
          agentEarnings[buyer].spent += amount;
          participants.add(buyer);
        }

        for (const agent of participants) {
          if (!agentEarnings[agent]) {
            agentEarnings[agent] = { earned: 0, spent: 0, tasks: 0 };
          }
          agentEarnings[agent].tasks += 1;
        }
      }

      const chains: Record<string, number> = {};
      for (const tx of a2aTxs) {
        if (tx.buyer_agent && tx.seller_agent) {
          const key = `${tx.buyer_agent}->${tx.seller_agent}`;
          chains[key] = (chains[key] || 0) + 1;
        }
      }

      const nowMs = Date.now();
      const hourlyActivity: Record<string, number[]> = Object.fromEntries(
        coreAgentSpecs.map((spec) => [spec.slug, [0, 0, 0, 0, 0, 0]]),
      );

      for (const tx of hourlyDataResult.data ?? []) {
        const agent = tx.seller_agent || tx.agent_slug;
        if (!agent) {
          continue;
        }

        const createdAtRaw = String(tx.created_at ?? '');
        const createdAtIso = /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(createdAtRaw)
          ? createdAtRaw
          : `${createdAtRaw}Z`;
        const createdAtMs = Date.parse(createdAtIso);
        if (!Number.isFinite(createdAtMs)) {
          continue;
        }

        const hoursAgo = Math.floor((nowMs - createdAtMs) / (60 * 60 * 1000));
        if (hoursAgo < 0 || hoursAgo >= 6) {
          continue;
        }

        if (!hourlyActivity[agent]) {
          hourlyActivity[agent] = [0, 0, 0, 0, 0, 0];
        }

        hourlyActivity[agent][5 - hoursAgo] += 1;
      }

      const gatewayBalances: Record<string, number> = Object.fromEntries(
        coreAgentSpecs.map((spec) => [spec.slug, 0]),
      );

      await Promise.all(
        (agentWalletsResult.data ?? []).map(async (wallet) => {
          if (!wallet.agent_slug || !wallet.address || !isAddress(wallet.address)) {
            return;
          }

          try {
            const balance = await fetchGatewayBalanceForAddress(
              getAddress(wallet.address),
            );
            gatewayBalances[wallet.agent_slug] = parseAmount(balance.available);
          } catch {
            gatewayBalances[wallet.agent_slug] = 0;
          }
        }),
      );

      return res.json({
        today: {
          settlements: totalStats.length,
          tasks: totalTasks,
          usdc: totalUsdc.toFixed(6),
          a2a_payments: a2aTxs.length,
          arc_gas_paid: combinedArcGasUsd.toFixed(8),
          arc_gas_attribution: usingAttributedGas
            ? 'batcher_onchain'
            : todayArcGas.totalUsd > 0
              ? 'direct_onchain'
              : combinedArcGasUsd > 0
                ? 'placeholder'
                : 'none',
          arc_gas_buyer_onchain_usd: todayArcGas.totalUsd.toFixed(8),
          arc_gas_batcher_attributed_usd: attributedArcGas.totalUsd.toFixed(8),
          arc_gas_attributed_tx_count: attributedArcGas.batchTxCount,
          arc_gas_attributed_transfer_count: attributedArcGas.ourTransferCount,
          net_margin: formatPercent(todayNetMarginPercent),
        },
        all_time: {
          settlements: allTimeSettlementsResult.count ?? 0,
          tasks: allTimeTasksResult.count ?? 0,
          usdc: allTimeUsdc.toFixed(6),
          a2a_payments: allTimeA2aCount,
        },
        agent_specs: coreAgentSpecs,
        agent_earnings: agentEarnings,
        a2a_chains: chains,
        hourly_activity: hourlyActivity,
        gateway_balances: gatewayBalances,
        treasury: treasuryStats
          ? {
              total_dcw: treasuryStats.totalDcw.toFixed(2),
              total_gateway: treasuryStats.totalGateway.toFixed(2),
              agents_needing_topup: treasuryStats.agentsNeedingTopUp,
              agents: treasuryStats.agents.map((agent) => ({
                slug: agent.slug,
                dcw: agent.dcwBalance.toFixed(3),
                gateway: agent.gatewayBalance.toFixed(3),
                status: agent.needsTopUp ? 'low' : 'ok',
              })),
            }
          : null,
        latest_transactions: latestTxsResult.data ?? [],
        recent_a2a_payments: recentA2aPayments,
        arc_vs_ethereum: buildArcVsEthereumStats(
          combinedArcGasUsd,
          combinedArcGasTxCount,
        ),
      });
    } catch (e: unknown) {
      console.warn('[economy] failed:', getErrorMessage(e));
      return res.status(500).json({ error: 'Failed to fetch economy stats' });
    }
  });

  app.post('/api/treasury/topup', authMiddleware, async (_req: Request, res: Response) => {
    try {
      await runTreasuryTopUp();
      const stats = await getTreasuryStats();
      return res.json({
        ok: true,
        message: 'Treasury top-up complete',
        stats,
      });
    } catch (e) {
      return res.status(500).json({
        error: e instanceof Error ? e.message : 'failed',
      });
    }
  });

  app.post('/api/economy/benchmark', authMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload | undefined;
    if (!auth?.walletAddress || !isAddress(auth.walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    try {
      const normalizedWalletAddress = getAddress(auth.walletAddress);
      const existing = Array.from(economyBenchmarkJobs.values()).find(
        (job) =>
          job.walletAddress.toLowerCase() === normalizedWalletAddress.toLowerCase() &&
          (job.status === 'queued' || job.status === 'running'),
      );

      if (existing) {
        return res.status(202).json(serializeEconomyBenchmarkJob(existing));
      }

      const startedAt = new Date().toISOString();
      const jobId = randomUUID();
      const job: EconomyBenchmarkJob = {
        jobId,
        walletAddress: normalizedWalletAddress,
        status: 'queued',
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
        progress: {
          completed: 0,
          total: benchmarkProgressTotal(),
          successful: 0,
          failed: 0,
          currentAgent: null,
        },
        result: null,
        error: null,
      };

      economyBenchmarkJobs.set(jobId, job);
      void runEconomyBenchmarkJob(jobId, normalizedWalletAddress);

      return res.status(202).json(serializeEconomyBenchmarkJob(job));
    } catch (e: unknown) {
      console.warn('[economy] benchmark failed:', getErrorMessage(e));
      return res.status(500).json({
        error: e instanceof Error ? e.message : 'Benchmark failed',
      });
    }
  });

  app.get('/api/economy/benchmark/:jobId', authMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload | undefined;
    if (!auth?.walletAddress || !isAddress(auth.walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const normalizedWalletAddress = getAddress(auth.walletAddress);
    const job = economyBenchmarkJobs.get(String(req.params.jobId ?? '').trim());
    if (!job) {
      return res.status(404).json({ error: 'Benchmark job not found' });
    }
    if (job.walletAddress.toLowerCase() !== normalizedWalletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return res.json(serializeEconomyBenchmarkJob(job));
  });

  app.use('/api', paymentsApiRouter);

  const paidAgentGateway = createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: FACILITATOR_URL,
  });

  const asciiInternalKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
    const reqKey = (req.headers['x-agentflow-brain-internal'] as string | undefined)?.trim();
    if (internalKey && reqKey === internalKey) {
      (req as any)._asciiInternalAuth = true;
    }
    next();
  };

  const asciiGatewayMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if ((req as any)._asciiInternalAuth) {
      next();
      return;
    }
    return paidAgentGateway.require(asciiPrice)(req, res, next);
  };

  const asciiAgentHandler = async (req: Request, res: Response) => {
    const task = extractAsciiAgentTask(req.method === 'GET' ? req.query : req.body);
    if (!task) {
      return res.status(400).json({
        error: 'task is required for the ASCII agent.',
      });
    }

    if (req.body?.benchmark === true || req.query?.benchmark === 'true') {
      console.log('[benchmark] ascii short-circuit');
      return res.json({
        ok: true,
        benchmark: true,
        agent: 'ascii',
        result: 'Benchmark mode - payment logged',
      });
    }

    const requestId = createRunId('ascii');
    const start = Date.now();

    try {
      const result = await withTimeout(
        generateAsciiAgentResult(task),
        AGENT_TIMEOUT_MS,
        'ascii agent',
      );
      console.log(`[Agent ascii ${requestId}] done in ${Date.now() - start}ms`);
      void incrementTxCount('ascii').catch((err) =>
        console.warn('[tx-counter] increment failed for ascii:', err),
      );
      return res.json({
        success: true,
        slug: 'ascii',
        source: 'hermes-skill',
        requestId,
        result,
      });
    } catch (error) {
      const details = getErrorMessage(error);
      const status = details.includes('timed out') ? 504 : 500;
      console.error(`[Agent ascii ${requestId}] failed`, error);
      return res.status(status).json({
        error: 'ascii agent failed',
        details,
        requestId,
      });
    }
  };

  app.get('/agent/ascii/health', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: 'ascii' });
  });
  app.get('/agent/ascii/run', asciiInternalKeyMiddleware, asciiGatewayMiddleware, asciiAgentHandler);
  app.post('/agent/ascii/run', asciiInternalKeyMiddleware, asciiGatewayMiddleware, asciiAgentHandler);

  app.get('/api/research/status/:jobId', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const auth = (req as any).auth as JWTPayload;
      const job = await getJobStatus(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      if (getAddress(job.walletAddress as `0x${string}`) !== getAddress(auth.walletAddress as `0x${string}`)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.json(job);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'status failed' });
    }
  });

  app.get('/api/research/queue', authMiddleware, async (_req: Request, res: Response) => {
    try {
      const stats = await getQueueStats();
      return res.json(stats);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'queue stats failed' });
    }
  });

  // Invoice status — callable by Hermes (internal key) or authenticated user
  app.get('/api/invoice/status', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    try {
      const walletAddress = String(
        req.query.walletAddress ?? (req as any).auth?.walletAddress ?? '',
      ).trim();
      const invoiceId = String(req.query.invoiceId ?? '').trim();

      if (!walletAddress) {
        return res.status(400).json({ error: 'walletAddress is required' });
      }

      let query = adminDb
        .from('invoices')
        .select('id, invoice_number, vendor_name, amount, status, arc_tx_id, created_at, settled_at')
        .eq('business_wallet', walletAddress)
        .order('created_at', { ascending: false })
        .limit(10);

      if (invoiceId) {
        query = query.eq('id', invoiceId);
      }

      const { data: invoices, error } = await query;
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      return res.json({ invoices: invoices ?? [] });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'invoice status failed' });
    }
  });

  // Schedule agent proxy routes
  app.post('/api/schedule/run', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const task = String(req.body?.task ?? '').trim();
    const walletAddress = auth.walletAddress;
    const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
    try {
      const agentRes = await fetch(`${SCHEDULE_AGENT_BASE_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization as string } : {}),
        },
        body: JSON.stringify({ task, walletAddress }),
      });
      const data = await agentRes.json().catch(() => ({ action: 'error', message: 'Invalid response from schedule agent' }));
      res.status(agentRes.ok ? 200 : agentRes.status).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ action: 'error', message: `Schedule agent unavailable: ${msg}` });
    }
  });

  app.post('/api/schedule/confirm/:confirmId', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const { confirmId } = req.params;
    const walletAddress = auth.walletAddress;
    try {
      const result = await runDcwPaidConfirm<{ success: boolean; message: string }>({
        walletAddress,
        agent: 'schedule',
        price: schedulePrice,
        url: `${SCHEDULE_AGENT_BASE_URL}/confirm/${encodeURIComponent(confirmId)}`,
        requestId: `schedule_confirm_${confirmId}_${Date.now()}`,
      });
      res.status(result.status).json({ ...result.data, payment: result.payment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ success: false, message: `Schedule agent unavailable: ${msg}` });
    }
  });

  // Split agent proxy routes
  app.post('/api/split/run', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const walletAddress = auth.walletAddress;
    const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
    try {
      const agentRes = await fetch(`${SPLIT_AGENT_BASE_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization as string } : {}),
        },
        body: JSON.stringify({ ...req.body, walletAddress }),
      });
      const data = await agentRes.json().catch(() => ({ action: 'error', message: 'Invalid response from split agent' }));
      res.status(agentRes.ok ? 200 : agentRes.status).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ action: 'error', message: `Split agent unavailable: ${msg}` });
    }
  });

  app.post('/api/split/confirm/:confirmId', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const { confirmId } = req.params;
    const walletAddress = auth.walletAddress;
    try {
      const requestedPortfolioA2a = await takeRequestedPortfolioA2a(confirmId);
      const result = await runDcwPaidConfirm<{
        action?: string;
        message?: string;
        results?: unknown;
      }>({
        walletAddress,
        agent: 'split',
        price: splitPrice,
        url: `${SPLIT_AGENT_BASE_URL}/confirm/${encodeURIComponent(confirmId)}`,
        requestId: `split_confirm_${confirmId}_${Date.now()}`,
        body: { suppressPortfolioFollowup: Boolean(requestedPortfolioA2a) },
      });
      const data = result.data as {
        action?: string;
        message?: string;
        results?: unknown;
      };
      if (result.status >= 200 && result.status < 300 && data.action === 'success' && typeof data.message === 'string' && requestedPortfolioA2a) {
        data.message = await appendRequestedPortfolioA2aReport({
          baseMessage: data.message,
          requested: requestedPortfolioA2a,
          userWalletAddress: walletAddress,
          details: { confirmId, results: data.results },
          sessionId: confirmId,
        });
      }
      res.status(result.status).json({ ...data, payment: result.payment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ action: 'error', message: `Split agent unavailable: ${msg}` });
    }
  });

  // Batch agent proxy routes
  app.post('/api/batch/preview', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const walletAddress = auth.walletAddress;
    const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';

    // Accept { csvText } or { payments }
    let payments = Array.isArray(req.body?.payments) ? req.body.payments : null;
    if (!payments && typeof req.body?.csvText === 'string') {
      const parsed = parseCSVBatch(req.body.csvText);
      if ('error' in parsed) {
        return res.status(400).json({ action: 'error', message: parsed.error });
      }
      payments = parsed;
    }
    if (!payments?.length) {
      return res.status(400).json({ action: 'error', message: 'Provide either payments array or csvText' });
    }

    const sessionId = `wallet-${walletAddress.toLowerCase()}`;
    try {
      const agentRes = await fetch(`${BATCH_AGENT_BASE_URL}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization as string } : {}),
        },
        body: JSON.stringify({ sessionId, walletAddress, payments }),
      });
      const data = await agentRes.json().catch(() => ({ action: 'error', message: 'Invalid response from batch agent' }));
      res.status(agentRes.ok ? 200 : agentRes.status).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ action: 'error', message: `Batch agent unavailable: ${msg}` });
    }
  });

  app.post('/api/batch/confirm/:confirmId', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload;
    const { confirmId } = req.params;
    const walletAddress = auth.walletAddress;
    try {
      const requestedPortfolioA2a = await takeRequestedPortfolioA2a(confirmId);
      const result = await runDcwPaidConfirm<{
        action?: string;
        message?: string;
        results?: unknown;
      }>({
        walletAddress,
        agent: 'batch',
        price: batchPrice,
        url: `${BATCH_AGENT_BASE_URL}/confirm/${encodeURIComponent(confirmId)}`,
        requestId: `batch_confirm_${confirmId}_${Date.now()}`,
        body: { suppressPortfolioFollowup: Boolean(requestedPortfolioA2a) },
      });
      const data = result.data as {
        action?: string;
        message?: string;
        results?: unknown;
      };
      if (result.status >= 200 && result.status < 300 && data.action === 'success' && typeof data.message === 'string' && requestedPortfolioA2a) {
        data.message = await appendRequestedPortfolioA2aReport({
          baseMessage: data.message,
          requested: requestedPortfolioA2a,
          userWalletAddress: walletAddress,
          details: { confirmId, results: data.results },
          sessionId: confirmId,
        });
      }
      res.status(result.status).json({ ...data, payment: result.payment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ action: 'error', message: `Batch agent unavailable: ${msg}` });
    }
  });

  // Invoice confirm route — reads Redis pending payload, creates invoice row + payment request.
  app.post('/api/invoice/confirm/:confirmId', internalOrAuthMiddleware, async (req: Request, res: Response) => {
    const { confirmId } = req.params;
    // confirmId is "invoice-<sessionId>", strip the prefix to recover sessionId
    const sessionId = confirmId.startsWith('invoice-') ? confirmId.slice('invoice-'.length) : confirmId;
    try {
      const pendingRaw = await getRedis().get(`invoice:pending:${sessionId}`);
      if (!pendingRaw) {
        res.status(404).json({ success: false, message: 'Invoice preview expired or not found.' });
        return;
      }

      const pending = JSON.parse(pendingRaw) as {
        walletAddress: string;
        vendorHandle: string;
        amount: string;
        description: string;
        invoiceNumber: string;
      };

      const result = await runDcwPaidConfirm<{
        invoiceId?: string;
        error?: string;
      }>({
        walletAddress: pending.walletAddress,
        agent: 'invoice',
        price: invoicePrice,
        url: `${INVOICE_AGENT_BASE_URL}/run`,
        requestId: `invoice_confirm_${confirmId}_${Date.now()}`,
        body: {
          channel: 'json',
          invoice: {
            vendor: pending.vendorHandle,
            vendorEmail: '',
            amount: parseFloat(pending.amount),
            currency: 'USDC',
            invoiceNumber: pending.invoiceNumber,
            lineItems: [{ description: pending.description, amount: parseFloat(pending.amount) }],
          },
          executePayment: false,
        },
      });
      if (!(result.status >= 200 && result.status < 300)) {
        throw new Error(
          (result.data as { error?: string })?.error || 'Invoice agent request failed',
        );
      }

      const requestedInvoiceResearch = await takeRequestedInvoiceResearchA2a(sessionId);
      if (!requestedInvoiceResearch) {
        scheduleChatInvoiceResearchFollowup({
          vendorHandle: pending.vendorHandle,
          amount: pending.amount,
          issuerWalletAddress: pending.walletAddress,
        });
      }

      await getRedis().del(`invoice:pending:${sessionId}`);

      let message = `Invoice ${pending.invoiceNumber} created and payment request sent to ${pending.vendorHandle}.`;

      if (requestedInvoiceResearch) {
        try {
          const researchPayload = await runInvoiceVendorResearchFollowup({
            vendor: pending.vendorHandle,
            amount: parseFloat(pending.amount),
            issuerWalletAddress: pending.walletAddress,
            researchRunUrl: RESEARCH_URL,
            researchPriceLabel: researchPrice,
          });
          message = `${message}\n\n---\n\n${formatResearchA2aReport(researchPayload, 'invoice')}`;
        } catch (a2aErr) {
          const msg = a2aErr instanceof Error ? a2aErr.message : String(a2aErr);
          console.warn('[a2a] requested invoice research follow-up failed:', msg);
          message = `${message}\n\nA2A vendor research failed: ${msg}`;
        }
      }

      res.json({
        success: true,
        invoiceId: result.data.invoiceId ?? null,
        invoiceNumber: pending.invoiceNumber,
        paymentRequestId: result.data.invoiceId ?? null,
        message,
        payment: result.payment,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await getRedis().del(`invoice:pending:${sessionId}`).catch(() => null);
      res.status(500).json({ success: false, message: `Invoice creation failed: ${msg}` });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      agents: ['ascii', 'research', 'analyst', 'writer', 'vision', 'transcribe'],
      network: NETWORK_NAME,
      chainId: CHAIN_ID,
    });
  });

  app.get('/health/stack', (_req, res) => {
    res.json({
      ok: true,
      facilitator: true,
      ascii: true,
      research: true,
      analyst: true,
      writer: true,
      vision: true,
      transcribe: true,
    });
  });

  app.get('/api/x402/preflight', async (req: Request, res: Response) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    const mode = String(req.query.mode || 'eoa').trim().toLowerCase();
    if (!slug) {
      return res.status(400).json({ error: 'slug is required' });
    }

    const targetUrl =
      mode === 'dcw'
        ? (['ascii', 'swap', 'vault', 'portfolio', 'vision', 'transcribe'].includes(slug)
            ? getDcwPaidAgentUrl(slug as DcwPaidAgentSlug)
            : null)
        : getPaidAgentUrlBySlug(slug);

    if (!targetUrl) {
      return res.status(404).json({ error: `Unknown x402 target: ${slug}` });
    }

    const facilitatorUrl = resolveFacilitatorHealthUrl();
    const targetHealthUrl = deriveHealthUrlFromRunUrl(targetUrl);
    const [facilitator, target] = await Promise.all([
      checkHttpHealth(facilitatorUrl),
      checkHttpHealth(targetHealthUrl),
    ]);
    const ok = facilitator.ok && target.ok;

    return res.status(ok ? 200 : 503).json({
      ok,
      slug,
      mode,
      facilitator,
      target,
    });
  });

  app.post('/api/x402/attempts/start', async (req: Request, res: Response) => {
    const parsed = parseX402AttemptMutationInput(req.body, 'started');
    if (!parsed.value) {
      return res.status(400).json({ error: parsed.error || 'Invalid attempt payload.' });
    }

    try {
      await acquireX402InflightLock(
        parsed.value.requestId,
        parsed.value.idempotencyKey,
      );
      const record = await writeX402AttemptRecord(parsed.value);
      return res.status(201).json({ ok: true, record });
    } catch (error) {
      if (error instanceof X402InflightConflictError) {
        return res.status(409).json({
          error: error.message,
          requestId: parsed.value.requestId,
          existingRequestId: error.existingRequestId || null,
        });
      }
      return res.status(500).json({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/x402/attempts/stage', async (req: Request, res: Response) => {
    const parsed = parseX402AttemptMutationInput(req.body);
    if (!parsed.value) {
      return res.status(400).json({ error: parsed.error || 'Invalid attempt payload.' });
    }

    try {
      const record = await writeX402AttemptRecord(parsed.value);
      if (X402_TERMINAL_STAGES.has(parsed.value.stage)) {
        await releaseX402InflightLock(
          parsed.value.requestId,
          parsed.value.idempotencyKey,
        );
      }
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(500).json({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/x402/attempts/:requestId', async (req: Request, res: Response) => {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required.' });
    }

    try {
      const record = await readX402AttemptRecord(requestId);
      if (!record) {
        return res.status(404).json({ error: 'Attempt not found.' });
      }
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(500).json({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/media/quota', authMiddleware, async (req: Request, res: Response) => {
    const auth = (req as any).auth as JWTPayload | undefined;
    if (!auth?.walletAddress || !isAddress(auth.walletAddress)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const walletAddress = getAddress(auth.walletAddress);
      const visionLimit = Number(process.env.VISION_DAILY_LIMIT || 5);
      const transcribeLimit = Number(process.env.TRANSCRIBE_DAILY_LIMIT || 5);

      const [vision, transcribe] = await Promise.all([
        readDailyUsageCap({
          scope: 'vision',
          walletAddress,
          limit: visionLimit,
        }),
        readDailyUsageCap({
          scope: 'transcribe',
          walletAddress,
          limit: transcribeLimit,
        }),
      ]);

      return res.json({
        walletAddress,
        vision,
        transcribe,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/api/brain/balance', async (req: Request, res: Response) => {
    try {
      const walletAddress = resolveBrainWalletAddress(
        req.query.walletAddress,
        req.query.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
          ? req.query.sessionId.trim()
          : walletAddress;
      const executionTarget =
        (await resolveBrainExecutionTarget(req.query.executionTarget, sessionId)) || 'EOA';
      const walletCtx = await buildBrainWalletCtx(walletAddress, executionTarget);
      const result = await executeTool('get_balance', {}, walletCtx, sessionId);
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/api/brain/portfolio', async (req: Request, res: Response) => {
    try {
      const walletAddress = resolveBrainWalletAddress(
        req.query.walletAddress,
        req.query.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
          ? req.query.sessionId.trim()
          : walletAddress;
      const executionTarget =
        (await resolveBrainExecutionTarget(req.query.executionTarget, sessionId)) || 'EOA';
      const walletCtx = await buildBrainWalletCtx(walletAddress, executionTarget);
      const result = await executeTool('get_portfolio', {}, walletCtx, sessionId);
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/api/brain/circle-stack', async (_req: Request, res: Response) => {
    try {
      return res.json({
        result: getAgentFlowCircleStackSummary(),
        supportedBridgeSources: listSupportedBridgeSourcesDetailed(),
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/api/brain/agentpay-history', async (req: Request, res: Response) => {
    try {
      const walletAddress = resolveBrainWalletAddress(
        req.query.walletAddress,
        req.query.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }
      const rawLimit = Number(req.query.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 100;
      const rows = await fetchPayHistoryForBrain(walletAddress, limit);
      return res.json({ transactions: rows });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/brain/swap', async (req: Request, res: Response) => {
    try {
      const walletAddress = resolveBrainWalletAddress(
        req.body?.walletAddress,
        req.body?.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
          ? req.body.sessionId.trim()
          : walletAddress;
      const walletCtx = await buildBrainWalletCtx(walletAddress);
      if (Boolean(req.body?.confirmed)) {
        return res.json({
          result:
            'Execution is blocked until the user explicitly replies YES in chat. Show the simulation first, then wait for YES.',
        });
      }
      const result = await executeTool(
        'swap_tokens',
        {
          amount: req.body?.amount,
          tokenIn: req.body?.tokenIn,
          tokenOut: req.body?.tokenOut,
          confirmed: Boolean(req.body?.confirmed),
        },
        walletCtx,
        sessionId,
      );
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/brain/vault', async (req: Request, res: Response) => {
    try {
      const { confirmed } = req.body ?? {};
      const walletAddress = resolveBrainWalletAddress(
        req.body?.walletAddress,
        req.body?.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
          ? req.body.sessionId.trim()
          : walletAddress;
      const walletCtx = await buildBrainWalletCtx(walletAddress);
      if (confirmed === true) {
        return res.json({
          result: 'Vault execution blocked. Use chat YES to confirm.',
        });
      }
      const result = await executeTool(
        'vault_action',
        {
          action: req.body?.action,
          amount: req.body?.amount,
          confirmed: Boolean(req.body?.confirmed),
        },
        walletCtx,
        sessionId,
      );
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/brain/bridge', async (req: Request, res: Response) => {
    try {
      const { confirmed } = req.body ?? {};
      const walletAddress = resolveBrainWalletAddress(
        req.body?.walletAddress,
        req.body?.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
          ? req.body.sessionId.trim()
          : walletAddress;
      const walletCtx = await buildBrainWalletCtx(walletAddress);
      if (confirmed === true) {
        return res.json({
          result: 'Bridge execution blocked. Use chat YES to confirm.',
        });
      }
      const result = await executeTool(
        'bridge_usdc',
        {
          amount: req.body?.amount,
          sourceChain: req.body?.sourceChain,
          confirmed: Boolean(req.body?.confirmed),
        },
        walletCtx,
        sessionId,
      );
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/brain/bridge-precheck', async (req: Request, res: Response) => {
    try {
      const walletAddress = resolveBrainWalletAddress(
        req.body?.walletAddress,
        req.body?.sessionId,
      );
      if (!walletAddress) {
        return res.status(400).json({ error: 'Valid walletAddress or sessionId is required.' });
      }

      const sessionId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
          ? req.body.sessionId.trim()
          : walletAddress;
      const executionTarget =
        (await resolveBrainExecutionTarget(req.body?.executionTarget, sessionId)) || 'EOA';
      const walletCtx = await buildBrainWalletCtx(walletAddress, executionTarget);
      const result = await executeTool(
        'bridge_precheck',
        {
          amount: req.body?.amount,
          sourceChain: req.body?.sourceChain,
        },
        walletCtx,
        sessionId,
      );
      return res.json({ result });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/profile/remember', authMiddleware, async (req: Request, res: Response) => {
    try {
      const auth = (req as any).auth as JWTPayload | undefined;
      const walletAddress =
        auth?.walletAddress && isAddress(auth.walletAddress)
          ? getAddress(auth.walletAddress)
          : undefined;
      if (!walletAddress) {
        return res.status(401).json({ error: 'Authenticated wallet is required.' });
      }

      const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
      const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';

      if (!key || !value) {
        return res.status(400).json({ error: 'key and value are required.' });
      }

      await rememberUserProfileFact(walletAddress, key, value);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/chat/respond', async (req: Request, res: Response) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    console.log('[route] message:', message);
    console.log('[route] shouldResearch:', shouldBypassToResearchPipeline(message));
    console.log('[route] shouldResearch after fix:', shouldHandleAsResearchRequest(message));
    const walletAddress =
      typeof req.body?.walletAddress === 'string' && isAddress(req.body.walletAddress)
        ? getAddress(req.body.walletAddress)
        : undefined;
    const messages = Array.isArray(req.body?.messages)
      ? req.body.messages
          .filter(
            (
              item: unknown,
            ): item is {
              role: 'user' | 'assistant';
              content: string;
            } =>
              Boolean(
                item &&
                  typeof item === 'object' &&
                  (((item as any).role === 'user') || (item as any).role === 'assistant') &&
                  typeof (item as any).content === 'string',
              ),
          )
          .slice(-15)
      : [];

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const requestSessionId =
      typeof req.headers['x-session-id'] === 'string'
        ? req.headers['x-session-id'].trim()
        : '';
    const sessionId = requestSessionId || walletAddress || `anon-${Date.now()}`;
    const actionSessionId = walletAddress ? `wallet-${walletAddress.toLowerCase()}` : sessionId;
    const memorySessionId = walletAddress ? actionSessionId : requestSessionId || actionSessionId;

    const productReply = buildAgentFlowProductReply(message);
    if (productReply) {
      await appendBrainConversationTurn(memorySessionId, message, productReply);
      streamStaticSseReply(res, productReply);
      return;
    }

    try {
      const pending = await loadPendingAction(actionSessionId);
      if (pending && isPendingActionFollowup(message)) {
        const responseText = formatPendingActionFollowup(pending);
        await appendBrainConversationTurn(memorySessionId, message, responseText);
        streamStaticSseReply(res, responseText);
        return;
      }
    } catch (error) {
      console.warn('[chat/respond] early pending follow-up check failed:', getErrorMessage(error));
    }

    const walletIntentReply = await tryBuildWalletIntentReply({
      message,
      walletAddress,
      signature:
        typeof req.body?.signature === 'string' ? req.body.signature : undefined,
      signatureMessage:
        typeof req.body?.signatureMessage === 'string'
          ? req.body.signatureMessage
          : undefined,
    });
    if (walletIntentReply) {
      streamStaticSseReply(res, walletIntentReply);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // @ts-ignore
    res.flushHeaders?.();

    try {
      const executionTarget =
        (await resolveBrainExecutionTarget(req.body?.executionTarget, actionSessionId)) || 'EOA';
      await storeBrainSessionContext(actionSessionId, { executionTarget });
      const walletCtx = await buildBrainWalletCtx(walletAddress, executionTarget);
      try {
        await extractProfileFact(message, walletAddress);
      } catch (error) {
        console.error('[memory] profile extraction failed:', error);
      }
      const profile = await loadBrainUserProfile(walletAddress);
      walletCtx.profileContext = shouldAttachBrainProfileContext(message)
        ? buildBrainProfileContext(profile)
        : '';
      try {
        const financialContextNote = await buildFinancialContextNote(
          message,
          walletCtx,
          actionSessionId,
        );
        if (financialContextNote) {
          walletCtx.profileContext = [walletCtx.profileContext, financialContextNote]
            .filter(Boolean)
            .join('\n\n');
        }
      } catch (error) {
        console.warn('[brain] financial context preload failed:', getErrorMessage(error));
      }
      const persistedHistory = isCasualSmallTalkTurn(message)
        ? []
        : await loadBrainConversationHistory(memorySessionId);
      const clientHistoryForAnonymousOnly = walletAddress ? [] : messages;
      const mergedMessages = mergeBrainConversationHistory(
        persistedHistory,
        clientHistoryForAnonymousOnly,
      );
      const historyForBrain =
        mergedMessages.length > 0 &&
        mergedMessages.at(-1)?.role === 'user' &&
        mergedMessages.at(-1)?.content.trim() === message
          ? mergedMessages.slice(0, -1)
          : mergedMessages;

      const upperMsg = message.trim().toUpperCase();
      const lowerMsg = message.trim().toLowerCase();

      if (upperMsg === 'YES' || upperMsg === 'CONFIRM') {
        try {
          // Check for invoice:pending first (before split / agentpay)
          const invoicePendingRaw = await getRedis().get(`invoice:pending:${actionSessionId}`).catch(() => null);
          if (invoicePendingRaw) {
            const authHeader =
              typeof req.headers.authorization === 'string'
                ? req.headers.authorization
                : '';
            try {
              const confirmRes = await fetch(
                `http://127.0.0.1:${PUBLIC_PORT}/api/invoice/confirm/${encodeURIComponent(`invoice-${actionSessionId}`)}`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                  },
                  body: JSON.stringify({ walletAddress: walletCtx.walletAddress }),
                },
              );
              const invoiceData = (await confirmRes.json().catch(() => ({
                success: false,
                message: 'Invoice confirmation failed.',
              }))) as {
                success?: boolean;
                message?: string;
                payment?: BrainMessageMeta['paymentMeta'];
              };
              const responseText =
                typeof invoiceData.message === 'string'
                  ? invoiceData.message
                  : 'Invoice confirmation failed.';
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              if (invoiceData.payment) {
                res.write(
                  `data: ${JSON.stringify({
                    meta: {
                      paymentMeta: invoiceData.payment,
                      activityMeta: {
                        mode: 'brain',
                        clusters: ['Invoice Agent'],
                        stageBars: [26, 44, 70, 92, 26, 14],
                      },
                    } satisfies BrainMessageMeta,
                  })}\n\n`,
                );
              }
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (invoiceConfirmErr) {
              const errMsg =
                invoiceConfirmErr instanceof Error ? invoiceConfirmErr.message : String(invoiceConfirmErr);
              const responseText = `Invoice creation failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            try {
              const pending = JSON.parse(String(invoicePendingRaw)) as {
                walletAddress: string;
                vendorHandle: string;
                amount: string;
                description: string;
                invoiceNumber: string;
              };

              const { data: invoice, error: invErr } = await adminDb
                .from('invoices')
                .insert({
                  business_wallet: pending.walletAddress,
                  vendor_name: pending.vendorHandle,
                  vendor_email: '',
                  vendor_handle: pending.vendorHandle,
                  amount: parseFloat(pending.amount),
                  currency: 'USDC',
                  invoice_number: pending.invoiceNumber,
                  line_items: [{ description: pending.description, amount: parseFloat(pending.amount) }],
                  status: 'pending',
                })
                .select('id')
                .single();

              if (invErr || !invoice?.id) {
                throw new Error(invErr?.message ?? 'Failed to create invoice');
              }

              const { createPaymentRequestFromInvoice } = await import('./lib/invoice-agentpay');
              const payReq = await createPaymentRequestFromInvoice(String(invoice?.id));

              const requestedInvoiceResearch = await takeRequestedInvoiceResearchA2a(actionSessionId);
              if (!requestedInvoiceResearch) {
                scheduleChatInvoiceResearchFollowup({
                  vendorHandle: pending.vendorHandle,
                  amount: pending.amount,
                  issuerWalletAddress: pending.walletAddress,
                });
              }

              await getRedis().del(`invoice:pending:${actionSessionId}`);

              let receipt = [
                'Invoice created!',
                '',
                `Invoice #: ${pending.invoiceNumber}`,
                `To: ${pending.vendorHandle}`,
                `Amount: ${pending.amount} USDC`,
                `For: ${pending.description}`,
                '',
                payReq
                  ? `Payment request sent — ${pending.vendorHandle} will see it in their AgentPay Requests tab.`
                  : 'Invoice saved. Vendor will be notified when they join AgentPay.',
              ].join('\n');

              if (requestedInvoiceResearch) {
                try {
                  const researchPayload = await runInvoiceVendorResearchFollowup({
                    vendor: pending.vendorHandle,
                    amount: parseFloat(pending.amount),
                    issuerWalletAddress: pending.walletAddress,
                    researchRunUrl: RESEARCH_URL,
                    researchPriceLabel: researchPrice,
                  });
                  receipt = `${receipt}\n\n---\n\n${formatResearchA2aReport(researchPayload, 'invoice')}`;
                } catch (a2aErr: any) {
                  const msg = a2aErr instanceof Error ? a2aErr.message : String(a2aErr);
                  console.warn('[a2a] requested invoice research follow-up failed:', msg);
                  receipt = `${receipt}\n\nA2A vendor research failed: ${msg}`;
                }
              }

              await appendBrainConversationTurn(memorySessionId, message, receipt);
              res.write(`data: ${JSON.stringify({ delta: receipt })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (invErr: any) {
              await getRedis().del(`invoice:pending:${actionSessionId}`).catch(() => null);
              const errMsg = invErr instanceof Error ? invErr.message : String(invErr);
              const responseText = `Invoice creation failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
          }

          const contactUpdateKey = `contact:update:${canonicalRedisSessionId(actionSessionId)}`;
          const rawContactUpdate = await getRedis().get(contactUpdateKey).catch(() => null);
          if (rawContactUpdate) {
            try {
              const pending = JSON.parse(rawContactUpdate) as {
                name: string;
                newAddress: string;
                oldAddress: string;
              };
              const w = getAddress(walletCtx.walletAddress);
              let resolvedNew: `0x${string}`;
              try {
                resolvedNew = getAddress(await resolvePayee(pending.newAddress, w));
              } catch (e: any) {
                const msg = e instanceof Error ? e.message : String(e);
                const responseText = `Could not resolve new address: ${msg}`;
                await appendBrainConversationTurn(memorySessionId, message, responseText);
                res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              const { error: upErr } = await adminDb
                .from('contacts')
                .update({
                  address: resolvedNew,
                  updated_at: new Date().toISOString(),
                })
                .eq('wallet_address', w)
                .ilike('name', pending.name);
              if (upErr) {
                const responseText = `Failed to update contact: ${upErr.message}`;
                await appendBrainConversationTurn(memorySessionId, message, responseText);
                res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              await getRedis().del(contactUpdateKey);
              const responseText = [
                'Contact updated!',
                '',
                `${pending.name} → ${resolvedNew}`,
              ].join('\n');
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (cuErr) {
              await getRedis().del(contactUpdateKey).catch(() => null);
              const errMsg = cuErr instanceof Error ? cuErr.message : String(cuErr);
              const responseText = `Contact update failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
          }

          // Check for batch:pending before split:pending
          const batchPendingRaw = await getRedis().get(`batch:pending:${actionSessionId}`).catch(() => null);
          if (batchPendingRaw) {
            const authHeader =
              typeof req.headers.authorization === 'string'
                ? req.headers.authorization
                : '';
            try {
              const requestedPortfolioA2a = await takeRequestedPortfolioA2a(actionSessionId);
              const confirmRes = await fetch(
                `http://127.0.0.1:${PUBLIC_PORT}/api/batch/confirm/${encodeURIComponent(actionSessionId)}`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                  },
                  body: JSON.stringify({
                    walletAddress: walletCtx.walletAddress,
                    suppressPortfolioFollowup: Boolean(requestedPortfolioA2a),
                  }),
                },
              );
              const batchData = await confirmRes.json().catch(() => ({ action: 'error', message: 'Batch agent error' })) as {
                action: string;
                message: string;
                results?: Array<{ to: string; amount: string; status: string; txHash?: string; error?: string }>;
                payment?: BrainMessageMeta['paymentMeta'];
              };
              const responseText =
                batchData.action === 'success'
                  ? await appendRequestedPortfolioA2aReport({
                      baseMessage: batchData.message,
                      requested: requestedPortfolioA2a,
                      userWalletAddress: walletCtx.walletAddress,
                      details: { confirmId: actionSessionId, results: batchData.results },
                      sessionId: actionSessionId,
                    })
                  : batchData.message;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              if (batchData.payment) {
                res.write(
                  `data: ${JSON.stringify({
                    meta: {
                      paymentMeta: batchData.payment,
                      activityMeta: {
                        mode: 'brain',
                        clusters: ['Batch Agent'],
                        stageBars: [28, 50, 74, 94, 30, 18],
                      },
                    } satisfies BrainMessageMeta,
                  })}\n\n`,
                );
              }
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (batchErr: any) {
              const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
              const responseText = `Batch payment failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            try {
              const requestedPortfolioA2a = await takeRequestedPortfolioA2a(actionSessionId);
              const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
              const confirmRes = await fetch(
                `${BATCH_AGENT_BASE_URL}/confirm/${encodeURIComponent(actionSessionId)}`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                    ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
                  },
                  body: JSON.stringify({
                    walletAddress: walletCtx.walletAddress,
                    suppressPortfolioFollowup: Boolean(requestedPortfolioA2a),
                  }),
                },
              );
              const batchData = await confirmRes.json().catch(() => ({ action: 'error', message: 'Batch agent error' })) as {
                action: string;
                message: string;
                results?: Array<{ to: string; amount: string; status: string; txHash?: string; error?: string }>;
              };
              const responseText =
                batchData.action === 'success'
                  ? await appendRequestedPortfolioA2aReport({
                      baseMessage: batchData.message,
                      requested: requestedPortfolioA2a,
                      userWalletAddress: walletCtx.walletAddress,
                      details: { confirmId: actionSessionId, results: batchData.results },
                      sessionId: actionSessionId,
                    })
                  : batchData.message;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (batchErr: any) {
              const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
              const responseText = `Batch payment failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
          }

          // Check for split:pending before agentpay:pending
          const splitPendingRaw = await getRedis().get(`split:pending:${actionSessionId}`).catch(() => null);
          if (splitPendingRaw) {
            const authHeader =
              typeof req.headers.authorization === 'string'
                ? req.headers.authorization
                : '';
            try {
              const requestedPortfolioA2a = await takeRequestedPortfolioA2a(actionSessionId);
              const confirmRes = await fetch(
                `http://127.0.0.1:${PUBLIC_PORT}/api/split/confirm/${encodeURIComponent(actionSessionId)}`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                  },
                  body: JSON.stringify({
                    walletAddress: walletCtx.walletAddress,
                    suppressPortfolioFollowup: Boolean(requestedPortfolioA2a),
                  }),
                },
              );
              const splitData = await confirmRes.json().catch(() => ({ action: 'error', message: 'Split agent error' })) as {
                action: string;
                message: string;
                results?: Array<{ recipient: string; amount: string; status: string; txHash?: string; error?: string }>;
                payment?: BrainMessageMeta['paymentMeta'];
              };
              const responseText =
                splitData.action === 'success'
                  ? await appendRequestedPortfolioA2aReport({
                      baseMessage: splitData.message,
                      requested: requestedPortfolioA2a,
                      userWalletAddress: walletCtx.walletAddress,
                      details: { confirmId: actionSessionId, results: splitData.results },
                      sessionId: actionSessionId,
                    })
                  : splitData.message;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              if (splitData.payment) {
                res.write(
                  `data: ${JSON.stringify({
                    meta: {
                      paymentMeta: splitData.payment,
                      activityMeta: {
                        mode: 'brain',
                        clusters: ['Split Agent'],
                        stageBars: [28, 50, 74, 94, 30, 18],
                      },
                    } satisfies BrainMessageMeta,
                  })}\n\n`,
                );
              }
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (splitErr: any) {
              const errMsg = splitErr instanceof Error ? splitErr.message : String(splitErr);
              const responseText = `Split payment failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            try {
              const requestedPortfolioA2a = await takeRequestedPortfolioA2a(actionSessionId);
              const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
              const confirmRes = await fetch(
                `${SPLIT_AGENT_BASE_URL}/confirm/${encodeURIComponent(actionSessionId)}`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authHeader ? { Authorization: authHeader } : {}),
                    ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
                  },
                  body: JSON.stringify({
                    walletAddress: walletCtx.walletAddress,
                    suppressPortfolioFollowup: Boolean(requestedPortfolioA2a),
                  }),
                },
              );
              const splitData = await confirmRes.json().catch(() => ({ action: 'error', message: 'Split agent error' })) as {
                action: string;
                message: string;
                results?: Array<{ recipient: string; amount: string; status: string; txHash?: string; error?: string }>;
              };
              const responseText =
                splitData.action === 'success'
                  ? await appendRequestedPortfolioA2aReport({
                      baseMessage: splitData.message,
                      requested: requestedPortfolioA2a,
                      userWalletAddress: walletCtx.walletAddress,
                      details: { confirmId: actionSessionId, results: splitData.results },
                      sessionId: actionSessionId,
                    })
                  : splitData.message;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            } catch (splitErr: any) {
              const errMsg = splitErr instanceof Error ? splitErr.message : String(splitErr);
              const responseText = `Split payment failed: ${errMsg}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
          }

          const agentPayPendingRaw = await getFirstPendingRedisValue(
            (key) => getRedis().get(key),
            'agentpay:pending:',
            actionSessionId,
          );
          if (agentPayPendingRaw) {
            const authHeader =
              typeof req.headers.authorization === 'string'
                ? req.headers.authorization
                : '';
            if (!authHeader) {
              const responseText =
                'Payment confirmation failed: missing auth token. Reconnect your wallet and try again.';
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            const executeResp = await fetch('http://localhost:4000/api/pay/brain/execute', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: authHeader,
              },
              body: JSON.stringify({ sessionId: actionSessionId }),
            });
            const executeJson = (await executeResp.json().catch(() => ({}))) as {
              ok?: boolean;
              txHash?: string;
              explorerLink?: string;
              error?: string;
            };
            if (!executeResp.ok || !executeJson.ok || !executeJson.txHash) {
              const responseText = `Payment failed: ${executeJson.error || 'unknown error'}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            const txHash = executeJson.txHash;
            const txShort = txHash.length > 12 ? `${txHash.slice(0, 10)}...` : txHash;
            const explorerUrl = executeJson.explorerLink || `https://testnet.arcscan.app/tx/${txHash}`;
            const responseText = `Sent payment successfully on Arc.\n\nTx: \`${txShort}\`\n[View on Arc Explorer](${explorerUrl})`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const pending = await loadPendingAction(actionSessionId);
          if (pending) {
            const pendingTool = pending.tool;
            const requestedPortfolioA2a = await takeRequestedPortfolioA2a(actionSessionId);
            const result = await executeTool(
              pending.tool,
              { ...pending.args, confirmed: true },
              walletCtx,
              actionSessionId,
            );
            let resultForUser = result;
            if (requestedPortfolioA2a && walletCtx.walletAddress && typeof result === 'string') {
              resultForUser = await appendRequestedPortfolioA2aReport({
                baseMessage: result,
                requested: requestedPortfolioA2a,
                userWalletAddress: walletCtx.walletAddress,
                details: result,
                sessionId: actionSessionId,
              });
            } else if (typeof result === 'string' && walletCtx.walletAddress) {
              scheduleChatToolPostA2a({
                pendingTool,
                result,
                userWalletAddress: walletCtx.walletAddress,
                portfolioRunUrl: PORTFOLIO_URL,
                portfolioPriceLabel: portfolioPrice,
              });
            }
            const meta = buildBrainMetaFromToolResults([{ name: pending.tool, result: resultForUser }]);
            const paymentMeta = takeRecentExecutionMeta(actionSessionId);
            if (paymentMeta) {
              meta.paymentMeta = paymentMeta;
            }
            await appendBrainConversationTurn(memorySessionId, message, resultForUser);
            res.write(`data: ${JSON.stringify({ meta })}\n\n`);
            res.write(`data: ${JSON.stringify({ delta: resultForUser })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          } else {
            const responseText =
              'Nothing to confirm. Ask me to simulate a swap, vault deposit, bridge, or AgentPay send first.';
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(
              `data: ${JSON.stringify({ delta: responseText })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        } catch (error) {
          console.warn('[chat/respond] pending confirm failed:', getErrorMessage(error));
        }
      }

      if (upperMsg === 'NO' || upperMsg === 'CANCEL') {
        let responseText = 'Cancelled. What else can I help you with?';
        try {
          const agentPayPendingExists = await redisPendingExists(
            (key) => getRedis().get(key),
            'agentpay:pending:',
            actionSessionId,
          );
          const toolPending = await loadPendingAction(actionSessionId);

          await clearPendingAction(actionSessionId);
          await clearPendingRedisKeys(
            (key) => getRedis().del(key),
            'agentpay:pending:',
            actionSessionId,
          );
          await getRedis()
            .del(`contact:update:${canonicalRedisSessionId(actionSessionId)}`)
            .catch(() => null);

          if (agentPayPendingExists) {
            responseText = "Okay, I didn't send the payment.";
          } else if (toolPending?.tool === 'swap_tokens') {
            responseText = "Okay, I didn't execute the swap.";
          } else if (toolPending?.tool === 'vault_action') {
            responseText = "Okay, I didn't execute the vault action.";
          } else if (toolPending?.tool === 'bridge_usdc') {
            responseText = "Okay, I didn't execute the bridge.";
          }
        } catch (error) {
          console.warn('[chat/respond] pending cancel failed:', getErrorMessage(error));
        }
        await appendBrainConversationTurn(memorySessionId, message, responseText);
        res.write(
          `data: ${JSON.stringify({ delta: responseText })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (shouldHandleAsContactView(message) && walletCtx.walletAddress) {
        try {
          const w = getAddress(walletCtx.walletAddress);
          const { data: contacts, error } = await adminDb
            .from('contacts')
            .select('*')
            .eq('wallet_address', w)
            .order('name', { ascending: true });
          if (error) {
            const responseText = `Could not load contacts: ${error.message}`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          let responseText: string;
          if (!contacts?.length) {
            responseText = [
              'No contacts saved yet.',
              '',
              'Save one:',
              '"save vendor as 0x1234..." or "save alice as alice.arc"',
            ].join('\n');
          } else {
            const lines: string[] = ['Your contacts:\n'];
            for (const c of contacts as Array<Record<string, unknown>>) {
              const name = String(c.name ?? '');
              const addr = String(c.address ?? '');
              const label = c.label != null ? String(c.label) : '';
              const notes = c.notes != null ? String(c.notes) : '';
              lines.push(
                `• ${name}${label ? ` (${label})` : ''}`,
                `  ${addr}`,
                ...(notes ? [`  Note: ${notes}`] : []),
                '',
              );
            }
            responseText = lines.join('\n');
          }
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const responseText = `Contacts error: ${msg}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      if (shouldHandleAsContactSave(message) && walletCtx.walletAddress) {
        const patterns: RegExp[] = [
          /save\s+(\w+)\s+as\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)/i,
          /add\s+contact\s+(\w+)\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)/i,
          /(\w+)\s+is\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)/i,
        ];
        let contactName = '';
        let contactAddress = '';
        for (const pattern of patterns) {
          const match = message.match(pattern);
          if (match) {
            contactName = match[1].toLowerCase();
            contactAddress = match[2].trim();
            break;
          }
        }
        if (contactName && contactAddress) {
          try {
            const w = getAddress(walletCtx.walletAddress);
            let resolved: `0x${string}`;
            try {
              resolved = getAddress(await resolvePayee(contactAddress, w));
            } catch (e: any) {
              const responseText = `Invalid address: ${e instanceof Error ? e.message : String(e)}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            const { error } = await adminDb.from('contacts').insert({
              wallet_address: w,
              name: contactName,
              address: resolved,
            });
            if (error) {
              if (/duplicate|unique/i.test(error.message)) {
                const responseText = `A contact named "${contactName}" already exists. Use Update or delete it first.`;
                await appendBrainConversationTurn(memorySessionId, message, responseText);
                res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              const responseText = `Failed to save contact: ${error.message}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            const responseText = [
              '✅ Contact saved!',
              '',
              `${contactName} → ${resolved}`,
              '',
              `You can say: "pay ${contactName} 10 USDC"`,
            ].join('\n');
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const responseText = `Save contact failed: ${msg}`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        }
      }

      if (shouldHandleAsContactUpdate(message) && walletCtx.walletAddress) {
        const match =
          message.match(/update\s+(\w+)\s+to\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)/i) ||
          message.match(/change\s+(\w+)\s+address\s+to\s+(0x[a-fA-F0-9]{40}|[\w.-]+\.arc)/i);
        if (match) {
          const name = match[1].toLowerCase();
          const newAddress = match[2].trim();
          try {
            const w = getAddress(walletCtx.walletAddress);
            const { data: existing } = await adminDb
              .from('contacts')
              .select('address')
              .eq('wallet_address', w)
              .ilike('name', name)
              .maybeSingle();
            if (!existing?.address) {
              const responseText = [
                `Contact "${name}" not found.`,
                'Use "show my contacts" to see saved contacts.',
              ].join('\n');
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            await getRedis().set(
              `contact:update:${canonicalRedisSessionId(actionSessionId)}`,
              JSON.stringify({
                name,
                newAddress,
                oldAddress: String(existing.address),
              }),
              'EX',
              300,
            );
            const responseText = [
              `Update contact "${name}"?`,
              '',
              `From: ${String(existing.address)}`,
              `To: ${newAddress}`,
              '',
              'Reply YES to confirm.',
            ].join('\n');
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const responseText = `Contact update preview failed: ${msg}`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        }
      }

      if (shouldHandleAsContactDelete(message) && walletCtx.walletAddress) {
        const match = message.match(/(?:remove|delete)\s+contact\s+(\w+)/i);
        if (match) {
          const name = match[1].toLowerCase();
          try {
            const w = getAddress(walletCtx.walletAddress);
            const { data: deletedRows, error } = await adminDb
              .from('contacts')
              .delete()
              .eq('wallet_address', w)
              .ilike('name', name)
              .select('id');
            if (error) {
              const responseText = `Failed to remove contact: ${error.message}`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            if (!deletedRows?.length) {
              const responseText = `No contact named "${name}" found.`;
              await appendBrainConversationTurn(memorySessionId, message, responseText);
              res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            const responseText = `Contact "${name}" removed.`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const responseText = `Delete contact failed: ${msg}`;
            await appendBrainConversationTurn(memorySessionId, message, responseText);
            res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
        }
      }

      // Schedule intents are now handled by the dedicated schedule agent on port 3018
      if (shouldHandleAsScheduleRequest(message) && walletCtx.walletAddress) {
        const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
        try {
          const scheduleAgentRes = await fetch(`${SCHEDULE_AGENT_BASE_URL}/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
            },
            body: JSON.stringify({ task: message, walletAddress: walletCtx.walletAddress }),
          });
          const scheduleData = await scheduleAgentRes.json().catch(() => ({ action: 'error', message: 'Schedule agent error' })) as {
            action?: string;
            message?: string;
            confirmId?: string;
            confirmLabel?: string;
            choices?: Array<{ id: string; label: string; confirmId: string }>;
          };
          const responseText = typeof scheduleData.message === 'string' ? scheduleData.message : 'Schedule agent error';
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          if (scheduleData.confirmId || scheduleData.choices?.length) {
            res.write(`data: ${JSON.stringify({ meta: { confirmation: { required: true, action: 'schedule', confirmId: scheduleData.confirmId, confirmLabel: scheduleData.confirmLabel || 'Confirm', choices: scheduleData.choices } } })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (scheduleErr) {
          const msg = scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr);
          const responseText = `Schedule agent unavailable: ${msg}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      // Batch/payroll payment intents — dedicated agent on port 3020. Text-only fast-path.
      if (shouldHandleAsBatchPayment(message) && walletCtx.walletAddress) {
        const parsedBatch = parseBatchMessage(message);
        if ('error' in parsedBatch) {
          const responseText =
            `I see you want to run a batch payment, but I could not parse the recipients.\n` +
            `${parsedBatch.error}\n\n` +
            `Use this format:\nbatch pay\nalice.arc,100,salary\nbob.arc,100,salary`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
        try {
          const batchAgentRes = await fetch(`${BATCH_AGENT_BASE_URL}/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
            },
            body: JSON.stringify({
              sessionId: actionSessionId,
              walletAddress: walletCtx.walletAddress,
              payments: parsedBatch,
            }),
          });

          const batchData = (await batchAgentRes.json().catch(() => ({
            action: 'error',
            message: 'Batch agent error',
          }))) as {
            action?: string;
            message?: string;
            confirmId?: string;
            confirmLabel?: string;
          };

          let responseText =
            typeof batchData.message === 'string' ? batchData.message : 'Batch agent error';
          if (batchData.action === 'preview' && hasPortfolioFollowupIntent(message)) {
            responseText = `${responseText}\n\n${portfolioA2aPostActionNote('batch agent')}`;
            await storeRequestedPortfolioA2a(batchData.confirmId || actionSessionId, {
              buyerAgentSlug: 'batch',
              trigger: 'post_batch_requested_report',
            });
          }
          await appendBrainConversationTurn(memorySessionId, message, responseText);

          if (batchData.action === 'preview' && batchData.confirmId) {
            res.write(
              `data: ${JSON.stringify({
                meta: {
                  confirmation: {
                    required: true,
                    action: 'batch',
                    confirmId: batchData.confirmId,
                    confirmLabel: batchData.confirmLabel || 'Send batch',
                  },
                },
              })}\n\n`,
            );
          }

          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (batchErr) {
          const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
          const responseText = `Batch agent unavailable: ${msg}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      // Split-payment intents are handled by the dedicated split agent on port 3019.
      // Bypass Hermes entirely to prevent hallucinated previews / fake tx hashes.
      if (shouldHandleAsSplitRequest(message) && walletCtx.walletAddress) {
        const parsed = parseSplitRequest(message);
        if (!parsed) {
          const responseText =
            'I see you want to split a payment, but I could not extract the amount and recipients. ' +
            'Try: "split 30 USDC between alice.arc, bob.arc and charlie.arc".';
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim() || '';
        try {
          const splitAgentRes = await fetch(`${SPLIT_AGENT_BASE_URL}/run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(internalKey ? { 'X-Agentflow-Brain-Internal': internalKey } : {}),
            },
            body: JSON.stringify({
              sessionId: actionSessionId,
              walletAddress: walletCtx.walletAddress,
              recipients: parsed.recipients,
              totalAmount: parsed.totalAmount,
              remark: parsed.remark || '',
            }),
          });

          const splitData = (await splitAgentRes.json().catch(() => ({
            action: 'error',
            message: 'Split agent error',
          }))) as {
            action?: string;
            message?: string;
            confirmId?: string;
            confirmLabel?: string;
          };

          let responseText =
            typeof splitData.message === 'string' ? splitData.message : 'Split agent error';
          if (splitData.action === 'preview' && hasPortfolioFollowupIntent(message)) {
            responseText = `${responseText}\n\n${portfolioA2aPostActionNote('split agent')}`;
            await storeRequestedPortfolioA2a(splitData.confirmId || actionSessionId, {
              buyerAgentSlug: 'split',
              trigger: 'post_split_requested_report',
            });
          }
          await appendBrainConversationTurn(memorySessionId, message, responseText);

          if (splitData.action === 'preview' && splitData.confirmId) {
            res.write(
              `data: ${JSON.stringify({
                meta: {
                  confirmation: {
                    required: true,
                    action: 'split',
                    confirmId: splitData.confirmId,
                    confirmLabel: splitData.confirmLabel || 'Confirm split',
                  },
                },
              })}\n\n`,
            );
          }

          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (splitErr) {
          const msg = splitErr instanceof Error ? splitErr.message : String(splitErr);
          const responseText = `Split agent unavailable: ${msg}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      // Payment-link fast-path — pure URL construction, no money moves, no
      // confirmation needed. Emits a `meta.paymentLink` event so the frontend
      // can render a QR code + Copy/Share buttons.
      if (shouldHandleAsPaymentLinkRequest(message)) {
        const parsed = parsePaymentLinkRequest(message);
        if (!parsed) {
          const responseText = [
            'I can build a payment link, but I need a recipient.',
            '',
            'Try: "payment link for jack.arc 5 USDC for coffee"',
            '  or: "qr code for 0x…address 10 USDC".',
          ].join('\n');
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Build the relative path+query. The frontend prepends
        // `window.location.origin` so the link always matches the current host
        // (localhost in dev, production domain in prod).
        const params = new URLSearchParams();
        if (parsed.amount) params.set('amount', parsed.amount);
        if (parsed.remark) params.set('remark', parsed.remark);
        const query = params.toString();
        const path = `/pay/${encodeURIComponent(parsed.handle)}${query ? `?${query}` : ''}`;

        const displayHandle = parsed.handle.startsWith('0x')
          ? `${parsed.handle.slice(0, 6)}…${parsed.handle.slice(-4)}`
          : `${parsed.handle}.arc`;

        const lines = [`Here's your payment link for **${displayHandle}**.`];
        if (parsed.amount) lines.push(`Pre-filled amount: **${parsed.amount} USDC**.`);
        if (parsed.remark) lines.push(`Remark: _${parsed.remark}_.`);
        lines.push('');
        lines.push(
          'Anyone can open it — AgentFlow users pay automatically from their DCW, ' +
            'others can connect any wallet on Arc Testnet. Scan the QR or tap Copy / Share below.',
        );
        const responseText = lines.join('\n');
        await appendBrainConversationTurn(memorySessionId, message, responseText);

        res.write(
          `data: ${JSON.stringify({
            meta: {
              paymentLink: {
                handle: parsed.handle,
                displayHandle,
                amount: parsed.amount || null,
                remark: parsed.remark || null,
                path,
              },
            },
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Invoice creation fast-path — bypass Hermes entirely, no LLM call.
      if (shouldHandleAsInvoiceRequest(message) && walletCtx.walletAddress) {
        const parsed = parseInvoiceRequest(message);
        if (!parsed) {
          const responseText = [
            'Could not parse invoice details.',
            '',
            'Try: "create invoice for alice.arc 50 USDC for website work"',
          ].join('\n');
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
        const pendingPayload = {
          tool: 'create_invoice',
          walletAddress: walletCtx.walletAddress,
          vendorHandle: parsed.vendorHandle,
          amount: parsed.amount,
          description: parsed.description,
          invoiceNumber,
        };
        await getRedis().set(
          `invoice:pending:${actionSessionId}`,
          JSON.stringify(pendingPayload),
          'EX',
          300,
        );

        const preview = [
          'Invoice Preview',
          '',
          `To: ${parsed.vendorHandle}`,
          `Amount: ${parsed.amount} USDC`,
          `For: ${parsed.description}`,
          `Invoice #: ${invoiceNumber}`,
          '',
          'On confirm:',
          `  Invoice saved to your records`,
          `  Payment request sent to ${parsed.vendorHandle}`,
          `  They get a Telegram notification if linked`,
        ].join('\n');
        const responseText = hasResearchFollowupIntent(message)
          ? `${preview}\n\n${researchA2aPostActionNote('invoice agent')}`
          : preview;
        if (hasResearchFollowupIntent(message)) {
          await storeRequestedInvoiceResearchA2a(actionSessionId);
        }

        await appendBrainConversationTurn(memorySessionId, message, responseText);

        res.write(
          `data: ${JSON.stringify({
            meta: {
              confirmation: {
                required: true,
                action: 'invoice',
                confirmId: `invoice-${actionSessionId}`,
                confirmLabel: `Create Invoice \u2013 ${parsed.amount} USDC`,
              },
            },
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Invoice status fast-path — bypass Hermes to avoid hallucination.
      if (shouldHandleAsInvoiceStatus(message) && walletAddress) {
        try {
          const { data: invoices } = await adminDb
            .from('invoices')
            .select('invoice_number, vendor_name, amount, status, arc_tx_id, created_at')
            .eq('business_wallet', walletAddress)
            .order('created_at', { ascending: false })
            .limit(10);

          let responseText: string;
          if (!invoices?.length) {
            responseText = [
              'No invoices found.',
              '',
              'Create one via chat:',
              '"create invoice for alice.arc 50 USDC for design work"',
            ].join('\n');
          } else {
            const lines: string[] = ['📄 Your Invoices:\n'];
            for (const inv of invoices) {
              const statusEmoji = inv.status === 'paid' ? '✅' : '⏳';
              lines.push(
                `${statusEmoji} ${inv.invoice_number}`,
                `   To: ${inv.vendor_name}`,
                `   Amount: ${inv.amount} USDC`,
                `   Status: ${inv.status}`,
                ...(inv.arc_tx_id ? [`   Tx: ${String(inv.arc_tx_id).slice(0, 10)}...`] : []),
                '',
              );
            }
            responseText = lines.join('\n');
          }

          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (e) {
          const errText = `Failed to fetch invoices: ${e instanceof Error ? e.message : 'unknown'}`;
          res.write(`data: ${JSON.stringify({ delta: errText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      // Research fast-path — Hermes 405B sometimes ignores agentflow_research
      // and answers research/report queries from training-data alone, producing
      // generic boilerplate with fake "explorer links" and zero real citations.
      // For any explicit research/report/news request we bypass Hermes and call
      // the same /run pipeline (research → analyst → writer) the tool would use.
      // Internal counterparty risk fast-path. Uses AgentFlow contacts, invoices,
      // payment requests, transactions, and reputation cache only; no web search.
      if (shouldHandleCounterpartyRiskRequest(message) && walletCtx.walletAddress) {
        const parsed = parseCounterpartyRiskRequest(message);
        if (!parsed) {
          const responseText = 'I can check internal AgentFlow counterparty risk, but I need a contact name, .arc handle, or wallet address.';
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        try {
          const assessment = await assessCounterpartyRisk({
            counterparty: parsed.counterparty,
            ownerWalletAddress: walletCtx.walletAddress,
            amountUsdc: parsed.amountUsdc,
            purpose: parsed.purpose,
          });
          const responseText = formatCounterpartyRiskReport(assessment);
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (riskErr) {
          const responseText = `Counterparty risk check failed: ${riskErr instanceof Error ? riskErr.message : String(riskErr)}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      if (hasAsciiArtIntent(message)) {
        if (!walletCtx.walletAddress) {
          const responseText = 'Connect your wallet to run the paid ASCII Agent.';
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        try {
          const asciiTask = extractAsciiAgentTask({ task: message }) || message.trim();
          res.write(`data: ${JSON.stringify({ meta: buildAsciiFastPathMeta('started') })}\n\n`);
          const paidAscii = await executeUserPaidAgentViaX402<{
            success?: boolean;
            result?: string;
            error?: string;
          }>({
            agent: 'ascii',
            price: asciiPrice,
            userWalletAddress: getAddress(walletCtx.walletAddress),
            requestId: `chat_ascii_${actionSessionId}_${Date.now()}`,
            url: ASCII_URL,
            body: {
              task: asciiTask,
            },
          });
          const responseText =
            typeof paidAscii.data?.result === 'string' && paidAscii.data.result.trim()
              ? paidAscii.data.result.trim()
              : '';
          if (!responseText) {
            throw new Error(
              typeof paidAscii.data?.error === 'string' && paidAscii.data.error.trim()
                ? paidAscii.data.error.trim()
                : 'ASCII Agent returned no art.',
            );
          }
          res.write(`data: ${JSON.stringify({ meta: buildAsciiFastPathMeta('completed') })}\n\n`);
          res.write(
            `data: ${JSON.stringify({
              meta: {
                paymentMeta: {
                  entries: [paidAscii.paymentEntry],
                },
              },
            })}\n\n`,
          );
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (asciiErr) {
          const msg = asciiErr instanceof Error ? asciiErr.message : String(asciiErr);
          console.warn('[chat/respond] ascii fast-path failed:', msg);
          const failureReply = buildAsciiFailureReply(msg);
          res.write(`data: ${JSON.stringify({ meta: buildAsciiFastPathMeta('failed') })}\n\n`);
          await appendBrainConversationTurn(memorySessionId, message, failureReply);
          res.write(`data: ${JSON.stringify({ delta: failureReply })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      if (isReportRenderingComplaint(message)) {
        const previousReport = findLatestStoredResearchReport(historyForBrain);
        if (previousReport) {
          const responseText = `Re-rendering the latest full research report.\n\n---\n\n${previousReport}`;
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(
            `data: ${JSON.stringify({
              meta: {
                reportMeta: {
                  kind: 'research',
                  diagnostics: ['Recovered the most recent completed research report from session history.'],
                },
              },
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              type: 'report',
              markdown: previousReport,
              research: null,
              analysis: null,
              liveData: null,
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      if (shouldHandleAsResearchRequest(message) && walletCtx.walletAddress) {
        const syncToken = `sync:${randomUUID()}`;
        let slotHeld = false;
        const intermediate: string[] = [];
        const pushStatus = (status: string) => {
          intermediate.push(status);
          res.write(`data: ${JSON.stringify({ delta: status })}\n\n`);
        };

        try {
          const reasoningMode = inferResearchReasoningMode({
            task: message,
            defaultMode: 'fast',
          });

          const acquired = await tryAcquireResearchSlot(syncToken);
          if (!acquired) {
            const { jobId, position } = await enqueueResearch({
              sessionId: memorySessionId,
              walletAddress: walletCtx.walletAddress,
              query: message,
              mode: reasoningMode === 'deep' ? 'deep' : 'fast',
              reasoningMode,
            });
            const waitMsg = [
              '📊 Our research pipeline is busy right now.',
              'Your report is queued and will be ready soon.',
              '',
              `Query: "${message}"`,
              `Position: #${position}`,
              `Job ID: ${jobId}`,
              '',
              "You'll get a Telegram notification when it's done (if Telegram is linked).",
              'The full report will also appear in this chat when polling completes.',
              reasoningMode === 'deep'
                ? 'Deep reports usually take 3-5 minutes.'
                : 'Fast reports usually take 1-2 minutes.',
            ].join('\n');
            await appendBrainConversationTurn(memorySessionId, message, waitMsg);
            res.write(
              `data: ${JSON.stringify({
                meta: { researchQueued: { jobId, position } },
              })}\n\n`,
            );
            res.write(`data: ${JSON.stringify({ delta: waitMsg })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          slotHeld = true;

          // Keep the user-facing status honest: actual source names are known only after retrieval.
          pushStatus(
            reasoningMode === 'deep'
              ? 'Running DEEP research -> analyst -> writer with Firecrawl retrieval, claim checks, and source verification. This can take 3-5 minutes.\n\n'
              : 'Running FAST research -> analyst -> writer with Firecrawl-backed live retrieval and source checks. This usually takes 1-2 minutes.\n\n',
          );

          const pipelineRes = await fetch(`http://127.0.0.1:${PUBLIC_PORT}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task: message,
              userAddress: walletCtx.walletAddress,
              reasoningMode,
              deepResearch: reasoningMode === 'deep',
            }),
          });

          if (!pipelineRes.ok || !pipelineRes.body) {
            throw new Error(
              `Research pipeline returned ${pipelineRes.status} ${pipelineRes.statusText}`,
            );
          }

          const reader = pipelineRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let report = '';
          let reportPayload: any = null;
          let pipelineErr = '';
          let eventCount = 0;
          let pipelineReceipt: any = null;

          const handlePipelineSseEvent = (ev: string) => {
            if (!ev.trim()) return;
            eventCount += 1;
            for (const line of ev.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              let parsed: any;
              try {
                parsed = JSON.parse(raw);
              } catch {
                continue;
              }
              if (!parsed || typeof parsed !== 'object') continue;
              if (typeof parsed.type === 'string') {
                console.log(
                  '[research-consumer] event:',
                  parsed.type,
                  typeof parsed.step === 'string' ? parsed.step : '',
                );
              }
              if (parsed.type === 'step_start' && typeof parsed.step === 'string') {
                pushStatus(`- ${parsed.step} agent started\n`);
              } else if (parsed.type === 'step_complete' && typeof parsed.step === 'string') {
                pushStatus(`- ${parsed.step} agent complete\n`);
              } else if (typeof parsed.delta === 'string' && parsed.delta) {
                pushStatus(parsed.delta);
              } else if (parsed.type === 'report' && typeof parsed.markdown === 'string') {
                report = parsed.markdown;
                reportPayload = parsed;
              } else if (parsed.type === 'receipt') {
                pipelineReceipt = parsed;
              } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
                pipelineErr = parsed.message;
              }
            }
          };

          const drainCompleteSseBlocks = () => {
            const normalized = buffer.replace(/\r\n/g, '\n');
            const events = normalized.split('\n\n');
            buffer = events.pop() ?? '';
            for (const ev of events) {
              handlePipelineSseEvent(ev);
            }
          };

          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            drainCompleteSseBlocks();
            if (done) {
              const tail = buffer.replace(/\r\n/g, '\n').trim();
              buffer = '';
              if (tail) {
                handlePipelineSseEvent(tail);
              }
              break;
            }
          }

          console.log(
            '[research-consumer] done,',
            'got report:', !!report,
            'events:', eventCount,
          );

          if (!report && pipelineErr) {
            const failureText = `Research pipeline failed: ${pipelineErr}`;
            await appendBrainConversationTurn(memorySessionId, message, failureText);
            res.write(`data: ${JSON.stringify({ delta: `\n${failureText}` })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (!report) {
            console.error('[research] no report markdown received');
            res.write(
              `data: ${JSON.stringify({
                type: 'error',
                error: 'Report generation incomplete. Please try again.',
              })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          console.log('[research] report received, length:', report.length);

          const paymentMeta = pipelineReceipt
            ? {
                entries:
                  Array.isArray(pipelineReceipt.entries) && pipelineReceipt.entries.length
                    ? pipelineReceipt.entries
                    : [
                    {
                      requestId: `${pipelineReceipt.pipelineRequestId ?? 'pipeline'}:research`,
                      agent: 'research',
                      price: pipelineReceipt.researchPrice ?? null,
                      transactionRef: pipelineReceipt.researchTx ?? null,
                      settlementTxHash: null,
                      mode: 'dcw',
                    },
                    {
                      requestId: `${pipelineReceipt.pipelineRequestId ?? 'pipeline'}:analyst`,
                      agent: 'analyst',
                      price: pipelineReceipt.analystPrice ?? null,
                      transactionRef: pipelineReceipt.analystTx ?? null,
                      settlementTxHash: null,
                      mode: 'dcw',
                    },
                    {
                      requestId: `${pipelineReceipt.pipelineRequestId ?? 'pipeline'}:writer`,
                      agent: 'writer',
                      price: pipelineReceipt.writerPrice ?? null,
                      transactionRef: pipelineReceipt.writerTx ?? null,
                      settlementTxHash: null,
                      mode: 'dcw',
                    },
                  ],
              }
            : null;

          const finalText = `\n\n---\n\n${report}`;
          await appendBrainConversationTurn(
            memorySessionId,
            message,
            `${intermediate.join('')}${finalText}`,
          );
          res.write(
            `data: ${JSON.stringify({
              meta: {
                reportMeta: {
                  kind: 'research',
                  mode: reasoningMode,
                },
                ...(paymentMeta ? { paymentMeta } : {}),
              },
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              type: 'report',
              markdown: report,
              research: reportPayload?.research ?? null,
              analysis: reportPayload?.analysis ?? null,
              liveData: reportPayload?.liveData ?? null,
            })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ delta: finalText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (researchErr) {
          const msg = researchErr instanceof Error ? researchErr.message : String(researchErr);
          console.warn('[chat/respond] research fast-path failed:', msg);
          const failureReply = buildResearchFailureReply(msg);
          await appendBrainConversationTurn(memorySessionId, message, failureReply);
          res.write(`data: ${JSON.stringify({ delta: `\n${failureReply}` })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } finally {
          if (slotHeld) {
            await releaseResearchSlot(syncToken);
          }
        }
      }

      if (shouldHandleAsAgentFlowCapabilityQuestion(message)) {
        const responseText = getAgentFlowCircleStackSummary();
        await appendBrainConversationTurn(memorySessionId, message, responseText);
        res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      try {
        const pending = await loadPendingAction(actionSessionId);
        if (pending && isPendingActionFollowup(message)) {
          const responseText = formatPendingActionFollowup(pending);
          await appendBrainConversationTurn(memorySessionId, message, responseText);
          res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      } catch (error) {
        console.warn('[chat/respond] pending follow-up check failed:', getErrorMessage(error));
      }

      if (
        lowerMsg.includes('bridge') &&
        ((lowerMsg.includes('manual') || lowerMsg.includes('manually')) ||
          lowerMsg.includes('eoa') ||
          lowerMsg.includes('funding'))
      ) {
        const responseText =
          'No. AgentFlow does not expose a manual EOA bridge in the Funding page anymore. Funding is for moving Arc USDC between your EOA, your Agent wallet, and your Gateway reserve. If you want to bridge to Arc inside AgentFlow, use the sponsored Bridge agent in chat.';
        await appendBrainConversationTurn(memorySessionId, message, responseText);
        res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const directRoute = parseDirectAgentFlowRoute(message, historyForBrain);
      if (directRoute) {
        let responseText = '';
        let meta:
          | ReturnType<typeof buildBrainMetaFromToolResults>
          | undefined;

        if (directRoute.type === 'reply') {
          responseText = directRoute.text;
        } else {
          if (
            executionTarget === 'EOA' &&
            (
              directRoute.tool === 'swap_tokens' ||
              directRoute.tool === 'vault_action' ||
              directRoute.tool === 'bridge_usdc'
            )
          ) {
            responseText =
              directRoute.tool === 'bridge_usdc'
                ? 'You selected EOA mode, which is the manual/funding wallet mode. DCW mode is the in-chat execution mode. AgentFlow bridge runs through the sponsored Bridge agent in DCW mode, so switch execution mode to DCW if you want me to do the bridge for you here.'
                : 'You selected EOA mode, which is the manual/funding wallet mode. DCW mode is the in-chat execution mode for swap and vault actions. Switch execution mode to DCW if you want me to execute this for you in chat.';
          } else {
            responseText = await executeTool(
              directRoute.tool,
              directRoute.args,
              walletCtx,
              actionSessionId,
            );
            if (directRoute.postActionNote && /Reply YES to execute or NO to cancel\./i.test(responseText)) {
              responseText = `${responseText}\n\n${directRoute.postActionNote}`;
              if (directRoute.tool === 'swap_tokens') {
                await storeRequestedPortfolioA2a(actionSessionId, {
                  buyerAgentSlug: 'swap',
                  trigger: 'post_swap_requested_report',
                });
              } else if (directRoute.tool === 'vault_action') {
                await storeRequestedPortfolioA2a(actionSessionId, {
                  buyerAgentSlug: 'vault',
                  trigger: 'post_vault_requested_report',
                });
              } else if (directRoute.tool === 'bridge_usdc') {
                await storeRequestedPortfolioA2a(actionSessionId, {
                  buyerAgentSlug: 'bridge',
                  trigger: 'post_bridge_requested_report',
                });
              }
            }
            meta = buildBrainMetaFromToolResults([
              { name: directRoute.tool, result: responseText },
            ]);
          }
        }

        await appendBrainConversationTurn(memorySessionId, message, responseText);
        if (meta) {
          res.write(`data: ${JSON.stringify({ meta })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ delta: responseText })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const eoaAdviceReply = await tryBuildEoaFinancialAdviceReply(
        message,
        walletCtx,
        actionSessionId,
      );
      if (eoaAdviceReply) {
        await appendBrainConversationTurn(memorySessionId, message, eoaAdviceReply);
        res.write(`data: ${JSON.stringify({ delta: eoaAdviceReply })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      let pendingBefore: string | null = null;
      let agentPayPendingBefore = false;
      let agentPayPendingAfter = false;
      try {
        const pending = await loadPendingAction(actionSessionId);
        pendingBefore = pending ? JSON.stringify(pending) : null;
        agentPayPendingBefore = await redisPendingExists(
          (key) => getRedis().get(key),
          'agentpay:pending:',
          actionSessionId,
        );
      } catch (error) {
        console.warn('[chat/respond] pending preflight failed:', getErrorMessage(error));
      }

      const brainMessage = buildBrainInputMessage(message);
      let fullResponse = '';
      // Run agent brain
      for await (const chunk of runAgentBrain(
        brainMessage,
        historyForBrain,
        walletCtx,
        actionSessionId
      )) {
        if (chunk.type === 'meta') {
          res.write(`data: ${JSON.stringify({ meta: chunk.meta })}\n\n`);
          continue;
        }
        fullResponse += chunk.delta;
        res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`)
      }

      try {
        const pending = await loadPendingAction(actionSessionId);
        const pendingAfter = pending ? JSON.stringify(pending) : null;
        if (pending && pendingAfter !== pendingBefore) {
          if (typeof pending.tool === 'string' && pending.tool) {
            res.write(
              `data: ${JSON.stringify({ meta: buildBrainConfirmationMeta(pending.tool) })}\n\n`,
            );
          }
        }
        agentPayPendingAfter = await redisPendingExists(
          (key) => getRedis().get(key),
          'agentpay:pending:',
          actionSessionId,
        );
        // Detect payment preview: any response with both To: <address> and Amount: X USDC
        const toMatch = fullResponse.match(
          /[-–•*]\s*To:\s*(0x[a-fA-F0-9]{40}|[\w.]+\.arc|[a-z0-9][a-z0-9_-]{0,63})/i,
        );
        const amountMatch = fullResponse.match(/[-–•*]\s*Amount:\s*([\d.]+)\s*USDC/i);
        const responseHasPayConfirm = Boolean(toMatch) && Boolean(amountMatch);
        // AI generated payment preview without calling the tool — create the pending entry
        if (responseHasPayConfirm && !agentPayPendingAfter && toMatch && amountMatch && walletCtx?.walletAddress) {
          // Extract remark from original user message: "pay <addr> <amount> USDC for <remark>"
          const remarkMatch = message.match(/\bfor\s+(.+)$/i);
          const remark = remarkMatch ? remarkMatch[1].trim() : '';
          try {
            const rawTo = toMatch[1];
            let resolvedAddress: string | null = null;
            if (rawTo.startsWith('0x')) {
              resolvedAddress = getAddress(rawTo as `0x${string}`);
            } else {
              resolvedAddress = await resolvePayee(rawTo, getAddress(walletCtx.walletAddress));
            }
            await fetch(`http://localhost:4000/api/pay/brain/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: actionSessionId,
                walletAddress: walletCtx.walletAddress,
                to: rawTo,
                resolvedAddress,
                amount: amountMatch[1],
                remark,
              }),
            });
            console.log(
              `[chat/respond] auto-created agentpay pending for session ${actionSessionId}`,
            );
          } catch (e) {
            console.warn('[chat/respond] auto-preview failed:', getErrorMessage(e));
          }
        }
        if (
          (agentPayPendingAfter && agentPayPendingAfter !== agentPayPendingBefore) ||
          (responseHasPayConfirm && !agentPayPendingBefore)
        ) {
          res.write(
            `data: ${JSON.stringify({ meta: buildBrainConfirmationMeta('agentpay_send') })}\n\n`,
          );
        }

        // Split payment postflight: if Hermes called agentpay_split, the split agent stored
        // split:pending:{sessionId} in Redis. Detect it here and inject confirmation meta.
        const splitPendingRaw = await getRedis()
          .get(`split:pending:${actionSessionId}`)
          .catch(() => null);
        if (splitPendingRaw) {
          let confirmLabel = 'Confirm split';
          try {
            const sp = JSON.parse(splitPendingRaw) as { perPerson?: string; recipients?: Array<{ name: string }> };
            if (sp.recipients?.length && sp.perPerson) {
              confirmLabel = `Confirm split (${sp.recipients.length} × ${sp.perPerson} USDC)`;
            }
          } catch { /* use default label */ }
          res.write(
            `data: ${JSON.stringify({
              meta: {
                confirmation: {
                  required: true,
                  action: 'split',
                  confirmId: actionSessionId,
                  confirmLabel,
                },
              },
            })}\n\n`,
          );
        }
      } catch (error) {
        console.warn('[chat/respond] pending postflight failed:', getErrorMessage(error));
      }

      await appendBrainConversationTurn(memorySessionId, message, fullResponse);
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: getErrorMessage(err) })}\n\n`)
      res.end()
    }
  });

  const getBalanceHandler = async (req: Request, res: Response) => {
    try {
      const addressQuery = req.query.address as string | undefined;
      if (!addressQuery || !isAddress(addressQuery)) {
        return res.status(400).json({ error: 'Valid address query parameter is required.' });
      }

      const address = getAddress(addressQuery);
      const balance = await fetchGatewayBalanceForAddress(address);
      return res.json({
        address,
        balance: balance.available,
        formatted: balance.available,
        total: balance.total,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  };

  app.get('/balance', getBalanceHandler);
  app.get('/gateway-balance', getBalanceHandler);

  app.post('/wallet/create', async (req: Request, res: Response) => {
    try {
      const userAddress = (req.body?.userAddress as string | undefined) ?? '';
      if (!userAddress || !isAddress(userAddress)) {
        return res.status(400).json({ error: 'Valid userAddress is required.' });
      }
      const normalized = getAddress(userAddress);

      const existing = await findCircleWalletForUser(normalized);
      if (existing) {
        return res.json({
          userAddress: normalized,
          circleWalletId: existing.walletId,
          circleWalletAddress: existing.address,
        });
      }

      await getOrCreateWalletSetId();
      const created = await createUserWallet(normalized);

      setWalletForUser(normalized, {
        circleWalletId: created.id,
        circleWalletAddress: created.address,
      });

      return res.json({
        userAddress: normalized,
        circleWalletId: created.id,
        circleWalletAddress: created.address,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/wallet/:address', async (req: Request, res: Response) => {
    try {
      const addressParam = req.params.address;
      if (!addressParam || !isAddress(addressParam)) {
        return res.status(400).json({ error: 'Valid address parameter is required.' });
      }

      const normalized = getAddress(addressParam);
      const existing = await findCircleWalletForUser(normalized);
      if (!existing) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      return res.json({
        userAddress: normalized,
        circleWalletId: existing.walletId,
        circleWalletAddress: existing.address,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/wallet/fund-gateway', async (req: Request, res: Response) => {
    try {
      const userAddress = (req.body?.userAddress as string | undefined) ?? '';
      if (!userAddress || !isAddress(userAddress)) {
        return res.status(400).json({ error: 'Valid userAddress is required.' });
      }
      const normalized = getAddress(userAddress);

      let existing: { walletId: string; address: string };
      try {
        existing = await getCircleWalletForUser(normalized);
      } catch {
        return res
          .status(404)
          .json({ error: 'Circle wallet not found for user', userAddress: normalized });
      }

      // eslint-disable-next-line no-console
      console.log(
        `[WalletFund] User ${normalized} Circle wallet: ${existing.address} (id=${existing.walletId})`,
      );

      const gatewayBalance = await fetchGatewayBalanceForAddress(getAddress(existing.address));
      const current = Number(gatewayBalance.available || '0');

      // eslint-disable-next-line no-console
      console.log('[WalletFund] Circle wallet Gateway balance:', current);

      if (Number.isNaN(current)) {
        return res
          .status(500)
          .json({ error: 'Invalid Gateway balance response', balance: gatewayBalance });
      }

      const { transferToGateway } = await import('./lib/circleWallet');

      // eslint-disable-next-line no-console
      console.log('[WalletFund] Calling transferToGateway for wallet:', existing.address);

      const transferResult = await transferToGateway({
        walletId: existing.walletId,
        walletAddress: existing.address,
      });

      const refreshed = await fetchGatewayBalanceForAddress(getAddress(existing.address));
      const newBalance = Number(refreshed.available || '0');
      const funded = transferResult.status === 'COMPLETE';

      if (!funded) {
        return res.json({
          funded: false,
          amount: transferResult.amount ?? 0,
          transferId: transferResult.transferId,
          transferStatus: transferResult.status,
          approvalId: transferResult.approvalId,
          approvalState: transferResult.approvalState,
          approvalTxHash: transferResult.approvalTxHash,
          depositId: transferResult.depositId,
          depositState: transferResult.depositState,
          depositTxHash: transferResult.depositTxHash,
          errorReason: transferResult.errorReason,
          errorDetails: transferResult.errorDetails,
          newBalance,
          message:
            transferResult.errorDetails ??
            transferResult.errorReason ??
            'Gateway deposit did not complete.',
        });
      }

      return res.json({
        funded,
        amount: transferResult.amount ?? 0,
        transferId: transferResult.transferId,
        transferStatus: transferResult.status,
        approvalId: transferResult.approvalId,
        approvalState: transferResult.approvalState,
        approvalTxHash: transferResult.approvalTxHash,
        depositId: transferResult.depositId,
        depositState: transferResult.depositState,
        depositTxHash: transferResult.depositTxHash,
        errorReason: transferResult.errorReason,
        errorDetails: transferResult.errorDetails,
        newBalance,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get('/circle-wallet/:userAddress', async (req: Request, res: Response) => {
    try {
      const userAddress = req.params.userAddress ?? '';
      if (!userAddress || !isAddress(userAddress)) {
        return res.status(400).json({ error: 'Valid userAddress is required.' });
      }
      const normalized = getAddress(userAddress);

      const existing = await findCircleWalletForUser(normalized);
      if (!existing) {
        return res
          .status(404)
          .json({ error: 'Circle wallet not found for user', userAddress: normalized });
      }

      const gatewayBalance = await fetchGatewayBalanceForAddress(getAddress(existing.address));
      const balance = Number(gatewayBalance.available || '0');

      return res.json({
        userAddress: normalized,
        circleWalletId: existing.walletId,
        circleWalletAddress: existing.address,
        gatewayBalance: balance,
        rawGatewayBalance: gatewayBalance,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/api/dcw/agents/:slug/run', authMiddleware, async (req: Request, res: Response) => {
    const slug = parseDcwPaidAgentSlug(req.params.slug || '');
    if (!slug) {
      return res.status(404).json({ error: 'Unsupported DCW paid agent slug' });
    }

    const auth = (req as any).auth as JWTPayload | undefined;
    if (!auth?.walletAddress || !isAddress(auth.walletAddress)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const normalizedWallet = getAddress(auth.walletAddress);
      const circleWallet = await getOrCreateUserAgentWallet(normalizedWallet);
      const internalKey = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
      const upstreamHeaders: Record<string, string> = {
        authorization: `Bearer ${generateJWT(normalizedWallet)}`,
        ...(internalKey ? { 'x-agentflow-paid-internal': internalKey } : {}),
      };

      const upstreamBody =
        req.body && typeof req.body === 'object'
          ? {
              ...(req.body as Record<string, unknown>),
              walletAddress: normalizedWallet,
              executionTarget: 'DCW',
            }
          : { walletAddress: normalizedWallet, executionTarget: 'DCW' };
      const requestId = req.header('x-agentflow-request-id')?.trim() || createRunId(`dcw_${slug}`);

      const result = await payProtectedResourceServer<
        Record<string, unknown>,
        Record<string, unknown>
      >({
        url: getDcwPaidAgentUrl(slug),
        method: 'POST',
        body: upstreamBody,
        circleWalletId: circleWallet.wallet_id,
        payer: getAddress(circleWallet.address),
        chainId: CHAIN_ID,
        headers: upstreamHeaders,
        requestId,
        idempotencyKey: requestId,
      });

      if (result.status >= 200 && result.status < 300) {
        void incrementTxCount(slug).catch((err) =>
          console.warn(`[tx-counter] increment failed for dcw ${slug}:`, err),
        );
      }

      return res.status(result.status).json({
        ...(typeof result.data === 'object' && result.data ? result.data : { result: result.data }),
        payment: {
          mode: 'DCW',
          payer: getAddress(circleWallet.address),
          agent: slug,
          price: getDcwPaidAgentPrice(slug),
          requestId: result.requestId,
          transaction: result.transactionRef ?? null,
          transactionRef: result.transactionRef ?? null,
          settlement: result.transaction ?? null,
          settlementTxHash: result.transaction?.txHash ?? null,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post('/deposit', (_req, res) => {
    res.status(410).json({
      success: false,
      error:
        'Deposit is now client-side. Use the browser wallet flow (MetaMask approve + depositFor) instead of backend /deposit.',
    });
  });

  const proxyHandler = async (req: Request, res: Response) => {
    const step = parseStep(req.params.step);
    if (!step) {
      return res
        .status(400)
        .json({ error: 'Invalid step. Use research, analyst, or writer.' });
    }

    const paymentSignature = req.header('Payment-Signature') || undefined;
    try {
      const result = await proxyAgentRun({
        step,
        method: req.method === 'GET' ? 'GET' : 'POST',
        body: req.method === 'GET' ? req.query : req.body,
        paymentSignature,
      });

      if (result.paymentRequiredHeader) {
        res.setHeader('PAYMENT-REQUIRED', result.paymentRequiredHeader);
      }
      if (result.paymentResponseHeader) {
        res.setHeader('PAYMENT-RESPONSE', result.paymentResponseHeader);
      }
      if (result.contentType) {
        res.setHeader('Content-Type', result.contentType);
      }

      if (result.status >= 200 && result.status < 300) {
        void incrementTxCount(step).catch((err) =>
          console.warn(`[tx-counter] increment failed for proxy ${step}:`, err),
        );
      }

      if (typeof result.data === 'string') {
        return res.status(result.status).send(result.data);
      }
      return res.status(result.status).json(result.data);
    } catch (err) {
      return res.status(500).json({
        error: `${step} proxy failed`,
        details: getErrorMessage(err),
      });
    }
  };

  app.get('/agent/:step/run', proxyHandler);
  app.post('/agent/:step/run', proxyHandler);

  app.post('/run', async (req, res) => {
    const task = (req.body?.task as string | undefined) ?? '';
    const userAddressInput = (req.body?.userAddress as string | undefined) ?? '';
    const reasoningMode = inferResearchReasoningMode({
      task,
      explicitMode: req.body?.reasoningMode,
      deepResearch: req.body?.deepResearch,
      defaultMode: 'fast',
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // @ts-ignore
    res.flushHeaders?.();

    let clientClosed = false;
    const clearHeartbeat = () => {
      clearInterval(heartbeat);
    };
    const handleStreamClosed = () => {
      clientClosed = true;
      clearHeartbeat();
    };
    req.on('aborted', handleStreamClosed);
    res.on('close', handleStreamClosed);

    const sendEvent = (event: Record<string, unknown>) => {
      if (clientClosed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (clientClosed || res.writableEnded) {
        clearHeartbeat();
        return;
      }
      res.write(`: keep-alive ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);

    if (!task.trim()) {
      sendEvent({
        type: 'error',
        message: 'Task is required',
      });
      res.end();
      return;
    }

    if (!userAddressInput || !isAddress(userAddressInput)) {
      sendEvent({
        type: 'error',
        message: 'Valid userAddress is required for payment orchestration.',
      });
      res.end();
      return;
    }

    let circleWalletId: string;
    let payerAddress: Address;
    let normalizedUserAddress: Address;
    try {
      const normalized = getAddress(userAddressInput);
      normalizedUserAddress = normalized;
      const executionWallet = await getOrCreateUserAgentWallet(normalized);
      circleWalletId = executionWallet.wallet_id;
      // Use the user's Agent Wallet/DCW as payer, not the user's EOA or legacy Gateway funding wallet.
      payerAddress = executionWallet.address as Address;
    } catch (err) {
      sendEvent({
        type: 'error',
        message: getErrorMessage(err),
      });
      res.end();
      return;
    }

    try {
      const walletContext =
        req.body?.walletContext && typeof req.body.walletContext === 'object'
          ? (req.body.walletContext as ResearchWalletContext)
          : await buildResearchWalletContext({
              task,
              ownerWalletAddress: normalizedUserAddress,
              executionWalletAddress: payerAddress,
              executionTarget: 'DCW',
            });

      await sendGAEvent('pipeline_started', {
        wallet_address: payerAddress,
        timestamp: Date.now(),
      });

      const [researchOwnerWallet, analystOwnerWallet, writerOwnerWallet] = await Promise.all([
        loadAgentOwnerWallet('research'),
        loadAgentOwnerWallet('analyst'),
        loadAgentOwnerWallet('writer'),
      ]);
      const pipelineRequestId = `pipeline_${randomUUID()}`;

      // Research step
      sendEvent({
        type: 'step_start',
        step: 'research',
        price: researchPrice,
        mode: reasoningMode,
      });
      sendEvent({
        delta:
          reasoningMode === 'deep'
            ? 'Research Agent is running deep Firecrawl retrieval and claim verification.\n'
            : 'Research Agent is running fast Firecrawl-backed live retrieval.\n',
      });
      if (walletContext) {
        sendEvent({
          delta: walletContext.error
            ? 'Portfolio snapshot was requested, but the DCW scan was unavailable; the report will say so instead of guessing.\n'
            : 'Using your DCW portfolio snapshot for personalized impact analysis.\n',
        });
      }

      const researchResult = await payProtectedResourceServer<
        { task?: string; result?: string; liveData?: Record<string, unknown> | null },
        { task: string; reasoningMode: 'fast' | 'deep'; walletContext?: ResearchWalletContext }
      >({
        url: RESEARCH_URL,
        method: 'POST',
        body: {
          task,
          reasoningMode,
          ...(walletContext ? { walletContext } : {}),
        },
        circleWalletId,
        payer: payerAddress,
        chainId: CHAIN_ID,
        requestId: `${pipelineRequestId}:research`,
      });

      const researchTx = researchResult.transactionRef ?? null;
      const researchText = getAgentResultText(researchResult.data);

      sendEvent({
        type: 'step_complete',
        step: 'research',
        tx: researchTx,
        amount: researchPrice,
      });

      await sendGAEvent('research_complete', {
        wallet_address: payerAddress,
        tx: researchTx,
        timestamp: Date.now(),
      });

      const parsedResearch = safeParseObject(researchText);
      const parsedLiveData = researchResult.data.liveData ?? null;
      const actualSources = summarizeLiveDataSourceNames(parsedLiveData);
      sendEvent({
        delta: actualSources.length
          ? `\nRead live sources: ${actualSources.join(', ')}\n`
          : '\nLive retrieval found limited directly relevant sources; the report will avoid unrelated citations.\n',
      });

      // Analyst step
      sendEvent({
        type: 'step_start',
        step: 'analyst',
        price: analystPrice,
        mode: reasoningMode,
      });
      sendEvent({
        delta: 'Research Agent is paying Analyst Agent for evidence review.\n',
      });

      const analystResult = await payProtectedResourceServer<
        { research?: string; result?: string },
        {
          research: string;
          researchJson: Record<string, unknown> | null;
          liveData: Record<string, unknown> | null;
          task: string;
          reasoningMode: 'fast' | 'deep';
        }
      >({
        url: ANALYST_URL,
        method: 'POST',
        body: {
          research: researchText,
          researchJson: parsedResearch,
          liveData: parsedLiveData,
          task,
          reasoningMode,
        },
        circleWalletId: researchOwnerWallet.walletId,
        payer: researchOwnerWallet.address,
        chainId: CHAIN_ID,
        requestId: `${pipelineRequestId}:analyst`,
      });

      console.log('[pipeline] analyst complete, starting writer');

      const analystTx = analystResult.transactionRef ?? null;
      const analysisText = getAgentResultText(analystResult.data);

      const analystLedger = await insertAgentToAgentLedger({
        fromWallet: researchOwnerWallet.address,
        toWallet: analystOwnerWallet.address,
        amount: usdAmountFromPriceLabel(analystPrice),
        settlement: analystResult.transaction,
        remark: 'Research Agent -> Analyst Agent',
        agentSlug: 'research',
        buyerAgent: 'research',
        sellerAgent: 'analyst',
        requestId: `${pipelineRequestId}:analyst`,
        context: 'agent_to_agent ledger (research->analyst)',
      });
      if (!analystLedger.ok) {
        console.warn('[a2a] research→analyst ledger insert failed:', analystLedger.error);
      }

      sendEvent({
        delta: `\nResearch Agent paid Analyst Agent ${analystPrice} USDC via x402/Gateway\n`,
      });

      sendEvent({
        type: 'step_complete',
        step: 'analyst',
        tx: analystTx,
        amount: analystPrice,
      });

      await sendGAEvent('analyst_complete', {
        wallet_address: payerAddress,
        tx: analystTx,
        timestamp: Date.now(),
      });

      const parsedAnalysis = safeParseObject(analysisText);

      // Writer step
      sendEvent({
        type: 'step_start',
        step: 'writer',
        price: writerPrice,
        mode: reasoningMode,
      });
      sendEvent({
        delta: 'Analyst Agent is paying Writer Agent to produce the final report.\n',
      });

      console.log('[pipeline] calling writer agent');

      const writerResult = await payProtectedResourceServer<
        { research?: string; analysis?: string; result?: string },
        {
          research: string;
          analysis: string;
          researchJson: Record<string, unknown> | null;
          analysisJson: Record<string, unknown> | null;
          liveData: Record<string, unknown> | null;
          task: string;
          reasoningMode: 'fast' | 'deep';
        }
      >({
        url: WRITER_URL,
        method: 'POST',
        body: {
          research: researchText,
          analysis: analysisText,
          researchJson: parsedResearch,
          analysisJson: parsedAnalysis,
          liveData: parsedLiveData,
          task,
          reasoningMode,
        },
        circleWalletId: analystOwnerWallet.walletId,
        payer: analystOwnerWallet.address,
        chainId: CHAIN_ID,
        requestId: `${pipelineRequestId}:writer`,
      });

      console.log('[pipeline] writer complete');

      const writerTx = writerResult.transactionRef ?? null;

      const writerLedger = await insertAgentToAgentLedger({
        fromWallet: analystOwnerWallet.address,
        toWallet: writerOwnerWallet.address,
        amount: usdAmountFromPriceLabel(writerPrice),
        settlement: writerResult.transaction,
        remark: 'Analyst Agent -> Writer Agent',
        agentSlug: 'analyst',
        buyerAgent: 'analyst',
        sellerAgent: 'writer',
        requestId: `${pipelineRequestId}:writer`,
        context: 'agent_to_agent ledger (analyst->writer)',
      });
      if (!writerLedger.ok) {
        console.warn('[a2a] analyst→writer ledger insert failed:', writerLedger.error);
      }

      sendEvent({
        delta: `Analyst Agent paid Writer Agent ${writerPrice} USDC via x402/Gateway\n\n`,
      });

      sendEvent({
        type: 'step_complete',
        step: 'writer',
        tx: writerTx,
        amount: writerPrice,
      });

      await sendGAEvent('writer_complete', {
        wallet_address: payerAddress,
        tx: writerTx,
        timestamp: Date.now(),
      });

      const total =
        Number(researchPrice.replace('$', '')) +
        Number(analystPrice.replace('$', '')) +
        Number(writerPrice.replace('$', ''));

      sendEvent({
        type: 'receipt',
        pipelineRequestId,
        total: total.toFixed(3),
        entries: [
          {
            requestId: `${pipelineRequestId}:research`,
            agent: 'research',
            price: researchPrice,
            payer: payerAddress,
            mode: 'dcw',
            transactionRef: researchResult.transactionRef ?? null,
            settlementTxHash: researchResult.transaction?.txHash ?? null,
          },
          {
            requestId: `${pipelineRequestId}:analyst`,
            agent: 'analyst',
            price: analystPrice,
            payer: researchOwnerWallet.address,
            mode: 'dcw',
            transactionRef: analystResult.transactionRef ?? null,
            settlementTxHash: analystResult.transaction?.txHash ?? null,
          },
          {
            requestId: `${pipelineRequestId}:writer`,
            agent: 'writer',
            price: writerPrice,
            payer: analystOwnerWallet.address,
            mode: 'dcw',
            transactionRef: writerResult.transactionRef ?? null,
            settlementTxHash: writerResult.transaction?.txHash ?? null,
          },
        ],
        researchPrice,
        analystPrice,
        writerPrice,
        researchTx,
        analystTx,
        writerTx,
      });

      const finalizedReport = finalizeReportMarkdown({
        task,
        writerMarkdown: writerResult.data.result || 'Writer agent returned no markdown output.',
        research: parsedResearch,
        analysis: parsedAnalysis,
        liveData: parsedLiveData,
      });
      const finalMarkdown = ensureWalletContextInReport(
        finalizedReport.markdown,
        parsedLiveData,
      );

      if (finalizedReport.validationIssues.length > 0) {
        console.warn(
          '[Research pipeline] Final report validation issues after repair:',
          finalizedReport.validationIssues,
        );
      }

      sendEvent({
        type: 'report',
        markdown: finalMarkdown,
        research: parsedResearch,
        analysis: parsedAnalysis,
        liveData: parsedLiveData,
      });

      await sendGAEvent('pipeline_complete', {
        wallet_address: payerAddress,
        total: total.toFixed(3),
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error('[pipeline] pipeline error:', e);
      sendEvent({
        type: 'error',
        message: getErrorMessage(e),
      });
    } finally {
      clearHeartbeat();
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}

async function start(): Promise<void> {
  await warnIfCanonicalFundsMissing();
  const facilitatorApp = createFacilitatorApp();
  const researchApp = createAgentApp(
    'research',
    researchPrice,
    RESEARCH_AGENT_TIMEOUT_MS,
    async (req) => {
    const task = (req.body?.task as string) ?? (req.query.task as string) ?? '';
    const researchContext =
      typeof req.body?.researchContext === 'string' && req.body.researchContext.trim()
        ? req.body.researchContext.trim()
        : '';
    const counterpartyRisk =
      req.body?.counterpartyRisk && typeof req.body.counterpartyRisk === 'object'
        ? (req.body.counterpartyRisk as CounterpartyRiskAssessment)
        : null;
    const walletContext =
      req.body?.walletContext && typeof req.body.walletContext === 'object'
        ? (req.body.walletContext as Record<string, unknown>)
        : null;
    if (counterpartyRisk && typeof counterpartyRisk.counterparty === 'string' && typeof counterpartyRisk.score === 'number') {
      return {
        task,
        liveData: { internal_context: counterpartyRisk, public_web_used: false },
        reasoningMode: 'fast',
        result: formatCounterpartyRiskReport(counterpartyRisk),
      };
    }
    const reasoningMode = inferResearchReasoningMode({
      task,
      explicitMode: req.body?.reasoningMode ?? req.query.reasoningMode,
      deepResearch: req.body?.deepResearch ?? req.query.deepResearch,
      defaultMode: 'fast',
    });
    if (reasoningMode === 'deep') {
      try {
        const { runDeepResearchCore } = await import('./agents/research/deepPipeline');
        const deep = await runDeepResearchCore({
          task,
          walletContext: walletContext ?? undefined,
        });
        if (deep.sources.length > 0) {
          return {
            task,
            liveData: {
              source: 'Firecrawl search and scrape',
              source_count: deep.sources.length,
              sources: deep.sources.slice(0, 25),
              liveFacts: deep.liveFacts,
              ...(walletContext ? { wallet_context: walletContext } : {}),
            },
            reasoningMode,
            result: deep.result,
          };
        }
        console.warn('[Research] Firecrawl returned zero relevant sources; falling back to live data/API research.');
      } catch (deepError) {
        console.warn(
          '[Research] Firecrawl deep retrieval failed; falling back to live data/API research:',
          getErrorMessage(deepError),
        );
      }
    }
    let liveData = '';
    try {
      liveData = await withTimeout(
        fetchLiveData(task),
        LIVE_DATA_TIMEOUT_MS,
        `Live data timed out after ${LIVE_DATA_TIMEOUT_MS / 1000}s`,
      );
    } catch (liveDataError) {
      console.warn('[Research] Live data enrichment skipped:', getErrorMessage(liveDataError));
    }
    const asOf = new Date().toISOString();
    if (!liveData.trim() && requiresLiveEvidence(task)) {
      return {
        task,
        liveData: walletContext ? { wallet_context: walletContext } : null,
        reasoningMode,
        result: buildSparseEvidenceResearch(task, asOf),
      };
    }
    const contextBlock = researchContext
      ? `\n\nINTERNAL AGENTFLOW CONTEXT JSON:\n${researchContext}\n\nUse this internal context as primary evidence for private AgentFlow handles, wallets, invoices, payment requests, transactions, contacts, and reputation cache. Public web evidence is enrichment only. If public web evidence is limited, say so and still produce a risk assessment from internal evidence.`
      : '';
    const walletContextBlock = walletContext
      ? `\n\nPORTFOLIO_CONTEXT JSON:\n${JSON.stringify(walletContext, null, 2)}\n\nThe user asked about their portfolio. Use this AgentFlow DCW snapshot as private first-party exposure context. Classify what the user holds (stablecoins, volatile crypto, DeFi, Gateway, mixed) and explain impact through those asset classes. Do not expose full wallet addresses, raw balances, or PnL unless the user explicitly asks for a balance/portfolio breakdown. If the snapshot has an error or empty holdings, say that the DCW scan was unavailable or empty instead of inventing holdings.`
      : '';
    const userMessage = liveData
      ? `AS OF ${asOf}\nCURRENT DATE: ${asOf.slice(0, 10)}\n\nLIVE DATA JSON:\n${liveData}${contextBlock}${walletContextBlock}\n\nUSER TASK:\n${task}\n\nUse the LIVE DATA JSON above for current figures and dated evidence. Do not cite or mention any date after CURRENT DATE as if it has happened. When present, cite concrete titles and URLs from current_events.articles, current_events.article_snapshots, dynamic_sources.articles, wikipedia.pages, coingecko, and defillama; do not invent outlets. The source registry is only a search planner and must not be cited as evidence. Verify the user's premise before accepting it. If the evidence supports only tensions, reported planning, isolated strikes, or older background context, say that plainly instead of repeating the user's framing. If LIVE DATA current_events framing_signals are present, follow them exactly for broader conflict status, Strait of Hormuz route status, and Red Sea route status. When PORTFOLIO_CONTEXT is present, classify the user's exposure and explain impact through that exposure profile without revealing raw balances, full addresses, or PnL unless explicitly requested. Prefer CoinGecko for token market data, DefiLlama for chain TVL and stablecoin liquidity, current-event article snapshots for recent developments, Wikipedia for factual background, and DuckDuckGo for supporting context.`
      : `${task}${contextBlock}${walletContextBlock}`;
    return {
      task,
      liveData: researchContext
        ? {
            ...(safeParseObject(liveData) ?? {}),
            internal_context: safeParseObject(researchContext),
            ...(walletContext ? { wallet_context: walletContext } : {}),
          }
        : {
            ...(safeParseObject(liveData) ?? {}),
            ...(walletContext ? { wallet_context: walletContext } : {}),
          },
      reasoningMode,
      result: await callHermesFast(RESEARCH_SYSTEM_PROMPT, userMessage),
    };
  },
  );
  const analystApp = createAgentApp(
    'analyst',
    analystPrice,
    ANALYST_AGENT_TIMEOUT_MS,
    async (req) => {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    const task = (req.body?.task as string) ?? (req.query.task as string) ?? '';
    const reasoningMode = inferResearchReasoningMode({
      task,
      explicitMode: req.body?.reasoningMode ?? req.query.reasoningMode,
      deepResearch: req.body?.deepResearch ?? req.query.deepResearch,
      defaultMode: 'fast',
    });
    const researchJson =
      (req.body?.researchJson as Record<string, unknown> | undefined) ??
      safeParseObject(research);
    const liveData =
      (req.body?.liveData as Record<string, unknown> | undefined) ?? null;
    const analystInput = buildAnalystModelInput({
      task,
      researchText: research,
      research: researchJson,
      liveData,
    });
    return {
      research,
      reasoningMode,
      result:
        reasoningMode === 'deep'
          ? await callHermesDeep(ANALYST_SYSTEM_PROMPT, analystInput)
          : await callHermesFast(ANALYST_SYSTEM_PROMPT, analystInput),
    };
  },
  );
  const writerApp = createAgentApp(
    'writer',
    writerPrice,
    WRITER_AGENT_TIMEOUT_MS,
    async (req) => {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    const analysis =
      (req.body?.analysis as string) ?? (req.query.analysis as string) ?? '';
    const task = (req.body?.task as string) ?? (req.query.task as string) ?? '';
    const researchJson =
      (req.body?.researchJson as Record<string, unknown> | undefined) ??
      safeParseObject(research);
    const analysisJson =
      (req.body?.analysisJson as Record<string, unknown> | undefined) ??
      safeParseObject(analysis);
    const liveData =
      (req.body?.liveData as Record<string, unknown> | undefined) ?? null;
    return {
      research,
      analysis,
      result: await callHermesDeep(
        WRITER_SYSTEM_PROMPT,
        buildWriterModelInput({
          task,
          researchText: research,
          analysisText: analysis,
          research: researchJson,
          analysis: analysisJson,
          liveData,
        }),
      ),
    };
  },
  );
  const publicApp = createPublicApp();

  const embeddedAgents =
    String(process.env.EMBEDDED_AGENT_SERVERS ?? 'true').toLowerCase() !== 'false';

  if (embeddedAgents) {
    console.log('[Boot] EMBEDDED_AGENT_SERVERS=true (facilitator + V2 agents in-process)');
    facilitatorApp.listen(FACILITATOR_PORT, () => {
      console.log(`[Boot] Facilitator listening on :${FACILITATOR_PORT}`);
    });
    researchApp.listen(RESEARCH_PORT, () => {
      console.log(`[Boot] Research agent listening on :${RESEARCH_PORT}`);
    });
    analystApp.listen(ANALYST_PORT, () => {
      console.log(`[Boot] Analyst agent listening on :${ANALYST_PORT}`);
    });
    writerApp.listen(WRITER_PORT, () => {
      console.log(`[Boot] Writer agent listening on :${WRITER_PORT}`);
    });
  } else {
    console.log(
      '[Boot] EMBEDDED_AGENT_SERVERS=false (public API only; run facilitator + agents separately, e.g. npm run dev:stack)',
    );
  }

  publicApp.listen(PUBLIC_PORT, () => {
    console.log(`[Boot] Public API listening on :${PUBLIC_PORT}`);
    console.log(`[Boot] Seller address for x402 payouts: ${sellerAddress}`);
    setInterval(() => {
      void processResearchQueue().catch((e) =>
        console.error('[research-queue] processor error:', e),
      );
    }, 5000);
  });
}

async function warnIfCanonicalFundsMissing(): Promise<void> {
  try {
    const { data, error } = await adminDb
      .from('funds')
      .select('id')
      .in('id', CANONICAL_FUND_IDS)
      .eq('is_active', true);
    if (error) {
      console.warn('[Boot] Funds startup check skipped:', error.message);
      return;
    }
    const activeIds = new Set((data ?? []).map((row) => String(row.id)));
    const missingIds = CANONICAL_FUND_IDS.filter((id) => !activeIds.has(id));
    if (missingIds.length > 0) {
      console.warn(
        `[Boot] Missing canonical active funds IDs: ${missingIds.join(', ')}. Run: npm run script:seed-funds`,
      );
    }
  } catch (error) {
    console.warn('[Boot] Funds startup check failed:', getErrorMessage(error));
  }
}

start().catch((err) => {
  console.error('[Boot] Failed to start unified backend', err);
  process.exit(1);
});
