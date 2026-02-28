import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import { getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BatchFacilitatorClient,
  createGatewayMiddleware,
  isBatchPayment,
} from '@circlefin/x402-batching/server';
import { GatewayClient } from '@circlefin/x402-batching/client';
import { callHermes } from './lib/hermes';

dotenv.config();

type OrchestratorStep = 'research' | 'analyst' | 'writer';

type StepEvent =
  | { type: 'step_start'; step: OrchestratorStep; price: string }
  | { type: 'step_complete'; step: OrchestratorStep; tx: string; amount: string }
  | {
      type: 'receipt';
      total: string;
      researchTx: string;
      analystTx: string;
      writerTx: string;
    }
  | { type: 'report'; markdown: string; summary: string }
  | { type: 'error'; message: string; step?: OrchestratorStep };

const NETWORK_NAME = 'Arc Testnet';
const CHAIN_ID = 5042002;

const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT || 3000);
const RESEARCH_PORT = Number(process.env.RESEARCH_AGENT_PORT || 3001);
const ANALYST_PORT = Number(process.env.ANALYST_AGENT_PORT || 3002);
const WRITER_PORT = Number(process.env.WRITER_AGENT_PORT || 3003);
const PUBLIC_PORT = Number(process.env.PORT || 4000);

const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const RESEARCH_URL = `http://127.0.0.1:${RESEARCH_PORT}/run`;
const ANALYST_URL = `http://127.0.0.1:${ANALYST_PORT}/run`;
const WRITER_URL = `http://127.0.0.1:${WRITER_PORT}/run`;

const PAYMENT_TIMEOUT_MS = Number(process.env.PAYMENT_TIMEOUT_MS || 90_000);
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 80_000);

const SYSTEM_PROMPTS = {
  research:
    'You are a research agent. Given a topic, find and summarize key facts, recent developments, and relevant data. Be thorough and factual. Return structured JSON.',
  analyst:
    'You are an analyst agent. Given raw research data, extract key insights, identify patterns, and provide analytical conclusions. Return structured JSON.',
  writer:
    'You are a writer agent. Given research and analysis, write a clear, well-structured report. Use markdown formatting. Make it professional and readable.',
  orchestrator:
    'You are an orchestrator agent. Given a user task and the outputs of research, analyst, and writer agents, summarize what was done and highlight key insights.',
};

function normalizePrivateKey(raw?: string): `0x${string}` {
  const value = raw?.trim();
  if (!value) {
    throw new Error('PRIVATE_KEY is not set in environment.');
  }
  return (value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`;
}

function parsePrice(input: string | undefined, fallback: string): string {
  return `$${(Number(input || fallback) || Number(fallback)).toFixed(3)}`;
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

function createRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.vercel.app')) return true;
    // Allow custom production domains over HTTPS.
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  const requestedHeaders = req.headers['access-control-request-headers'];
  if (typeof requestedHeaders === 'string' && requestedHeaders.trim()) {
    res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
  } else {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

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

const sellerAccount = privateKeyToAccount(normalizePrivateKey(process.env.PRIVATE_KEY));
const sellerAddress: Address =
  (process.env.SELLER_ADDRESS?.trim() as Address) || sellerAccount.address;

const researchPrice = parsePrice(process.env.RESEARCH_AGENT_PRICE, '0.005');
const analystPrice = parsePrice(process.env.ANALYST_AGENT_PRICE, '0.003');
const writerPrice = parsePrice(process.env.WRITER_AGENT_PRICE, '0.008');

function createFacilitatorApp(): express.Express {
  const app = express();
  app.use(express.json());
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
      res.status(500).json({ error: 'Internal error during getSupported', details, requestId: rid });
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
        return res
          .status(400)
          .json({ error: 'Only Gateway batched payments are supported', requestId: rid });
      }
      const result = await gatewayClient.verify(paymentPayload, paymentRequirements);
      if ('isValid' in result && result.isValid === false) {
        console.error(`[Facilitator ${rid}] verify failed`, result.errorReason ?? result);
      }
      return res.json(result);
    } catch (err) {
      const details = getErrorMessage(err);
      console.error(`[Facilitator ${rid}] /verify failed`, err);
      return res.status(500).json({ error: 'Internal error during verify', details, requestId: rid });
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
        return res
          .status(400)
          .json({ error: 'Only Gateway batched payments are supported', requestId: rid });
      }
      const result = await gatewayClient.settle(paymentPayload, paymentRequirements);
      if (!result.success) {
        console.error(`[Facilitator ${rid}] settle failed`, result.errorReason ?? result);
      }
      return res.json(result);
    } catch (err) {
      const details = getErrorMessage(err);
      console.error(`[Facilitator ${rid}] /settle failed`, err);
      return res.status(500).json({ error: 'Internal error during settle', details, requestId: rid });
    }
  });

  return app;
}

function createAgentApp(
  name: OrchestratorStep,
  price: string,
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
      const payload = await withTimeout(
        run(req),
        AGENT_TIMEOUT_MS,
        `${name} agent`,
      );
      console.log(`[Agent ${name} ${requestId}] done in ${Date.now() - start}ms`);
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

function createGatewayClientForUser(userAddress?: string): GatewayClient {
  const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY);
  const client = new GatewayClient({
    chain: 'arcTestnet',
    privateKey,
  });

  if (userAddress) {
    if (!isAddress(userAddress)) {
      throw new Error('userAddress is invalid.');
    }
    const normalized = getAddress(userAddress);
    if (normalized.toLowerCase() !== client.address.toLowerCase()) {
      throw new Error(
        `Connected wallet ${normalized} does not match backend signer ${client.address}. Configure PRIVATE_KEY to the connected wallet for server-side payments.`,
      );
    }
  }

  return client;
}

async function runPipeline(
  task: string,
  userAddress: string | undefined,
  onEvent: (event: StepEvent) => void,
): Promise<void> {
  const client = createGatewayClientForUser(userAddress);

  onEvent({ type: 'step_start', step: 'research', price: researchPrice.replace('$', '') });
  const research = await withTimeout(
    client.pay<{ task?: string; result?: string }>(RESEARCH_URL, {
      method: 'POST',
      body: { task },
    }),
    PAYMENT_TIMEOUT_MS,
    'Research payment',
  ).catch((err) => {
    throw Object.assign(new Error(`Research step failed: ${getErrorMessage(err)}`), {
      step: 'research' as OrchestratorStep,
    });
  });
  onEvent({
    type: 'step_complete',
    step: 'research',
    tx: research.transaction,
    amount: researchPrice.replace('$', ''),
  });

  onEvent({ type: 'step_start', step: 'analyst', price: analystPrice.replace('$', '') });
  const analyst = await withTimeout(
    client.pay<{ research?: string; result?: string }>(ANALYST_URL, {
      method: 'POST',
      body: { research: JSON.stringify(research.data) },
    }),
    PAYMENT_TIMEOUT_MS,
    'Analyst payment',
  ).catch((err) => {
    throw Object.assign(new Error(`Analyst step failed: ${getErrorMessage(err)}`), {
      step: 'analyst' as OrchestratorStep,
    });
  });
  onEvent({
    type: 'step_complete',
    step: 'analyst',
    tx: analyst.transaction,
    amount: analystPrice.replace('$', ''),
  });

  onEvent({ type: 'step_start', step: 'writer', price: writerPrice.replace('$', '') });
  const writer = await withTimeout(
    client.pay<{ result?: string }>(WRITER_URL, {
      method: 'POST',
      body: {
        research: JSON.stringify(research.data),
        analysis: JSON.stringify(analyst.data),
      },
    }),
    PAYMENT_TIMEOUT_MS,
    'Writer payment',
  ).catch((err) => {
    throw Object.assign(new Error(`Writer step failed: ${getErrorMessage(err)}`), {
      step: 'writer' as OrchestratorStep,
    });
  });
  onEvent({
    type: 'step_complete',
    step: 'writer',
    tx: writer.transaction,
    amount: writerPrice.replace('$', ''),
  });

  const total =
    Number(researchPrice.replace('$', '')) +
    Number(analystPrice.replace('$', '')) +
    Number(writerPrice.replace('$', ''));
  onEvent({
    type: 'receipt',
    total: total.toFixed(3),
    researchTx: research.transaction,
    analystTx: analyst.transaction,
    writerTx: writer.transaction,
  });

  const summary = await callHermes(
    SYSTEM_PROMPTS.orchestrator,
    JSON.stringify({
      task,
      research: research.data,
      analyst: analyst.data,
      writer: writer.data,
      userAddress: userAddress || client.address,
    }),
  );
  onEvent({
    type: 'report',
    markdown: writer.data?.result || '',
    summary,
  });
}

function createPublicApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(corsMiddleware);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      agents: ['research', 'analyst', 'writer'],
      network: NETWORK_NAME,
      chainId: CHAIN_ID,
    });
  });

  app.get('/health/stack', (_req, res) => {
    res.json({
      ok: true,
      facilitator: true,
      research: true,
      analyst: true,
      writer: true,
    });
  });

  const getBalanceHandler = async (req: Request, res: Response) => {
    try {
      const client = createGatewayClientForUser();
      const addressParam = req.query.address as string | undefined;
      if (addressParam && !isAddress(addressParam)) {
        return res.status(400).json({ error: 'Invalid address query parameter.' });
      }
      const targetAddress = addressParam ? getAddress(addressParam) : undefined;
      const balances = await client.getBalances(targetAddress as Address | undefined);
      return res.json({
        address: targetAddress ?? client.address,
        balance: balances.gateway.formattedAvailable,
        formatted: balances.gateway.formattedAvailable,
        total: balances.gateway.formattedTotal,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
      });
    } catch (err) {
      return res.status(500).json({ error: getErrorMessage(err) });
    }
  };

  app.get('/balance', getBalanceHandler);
  app.get('/gateway-balance', getBalanceHandler);

  app.post('/deposit', async (req, res) => {
    try {
      const client = createGatewayClientForUser();
      const amount = (req.body?.amount as string) || '1';
      const depositorRaw = req.body?.depositor as string | undefined;
      if (depositorRaw) {
        const depositor = getAddress(depositorRaw);
        const result = await client.depositFor(amount, depositor);
        return res.json({
          success: true,
          txHash: result.depositTxHash,
          formattedAmount: result.formattedAmount,
        });
      }
      const result = await client.deposit(amount);
      return res.json({
        success: true,
        txHash: result.depositTxHash,
        formattedAmount: result.formattedAmount,
      });
    } catch (err) {
      return res
        .status(500)
        .json({ error: getErrorMessage(err), success: false });
    }
  });

  app.post('/run', async (req, res) => {
    const task = (req.body?.task as string | undefined)?.trim() || '';
    const userAddress = (req.body?.userAddress as string | undefined)?.trim();
    const runId = createRunId('run');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    res.flushHeaders?.();

    let disconnected = false;
    req.on('aborted', () => {
      disconnected = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) disconnected = true;
    });

    const sendEvent = (event: StepEvent) => {
      if (disconnected || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (!task) {
      sendEvent({ type: 'error', message: 'Task is required.' });
      res.end();
      return;
    }

    try {
      console.log(`[Public ${runId}] task="${task}" userAddress=${userAddress || 'n/a'}`);
      await runPipeline(task, userAddress, sendEvent);
    } catch (err) {
      const message = getErrorMessage(err);
      const step = (err as { step?: OrchestratorStep }).step;
      console.error(`[Public ${runId}] pipeline failed`, err);
      sendEvent({ type: 'error', message, step });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}

async function start(): Promise<void> {
  const facilitatorApp = createFacilitatorApp();
  const researchApp = createAgentApp('research', researchPrice, async (req) => {
    const task = (req.body?.task as string) ?? (req.query.task as string) ?? '';
    return {
      task,
      result: await callHermes(SYSTEM_PROMPTS.research, task),
    };
  });
  const analystApp = createAgentApp('analyst', analystPrice, async (req) => {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    return {
      research,
      result: await callHermes(SYSTEM_PROMPTS.analyst, research),
    };
  });
  const writerApp = createAgentApp('writer', writerPrice, async (req) => {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    const analysis =
      (req.body?.analysis as string) ?? (req.query.analysis as string) ?? '';
    return {
      research,
      analysis,
      result: await callHermes(
        SYSTEM_PROMPTS.writer,
        `RESEARCH:\n${research}\n\nANALYSIS:\n${analysis}`,
      ),
    };
  });
  const publicApp = createPublicApp();

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
  publicApp.listen(PUBLIC_PORT, () => {
    console.log(`[Boot] Public API listening on :${PUBLIC_PORT}`);
  });
}

start().catch((err) => {
  console.error('[Boot] Failed to start unified backend', err);
  process.exit(1);
});
