import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import { getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BatchFacilitatorClient,
  createGatewayMiddleware,
  isBatchPayment,
} from '@circlefin/x402-batching/server';
import { callHermes } from './lib/hermes';

dotenv.config();

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

const NETWORK_NAME = 'Arc Testnet';
const CHAIN_ID = 5042002;
const ARC_TESTNET_DOMAIN = Number(process.env.GATEWAY_DOMAIN || 26);
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL || 'https://gateway-api-testnet.circle.com/v1';

const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT || 3000);
const RESEARCH_PORT = Number(process.env.RESEARCH_AGENT_PORT || 3001);
const ANALYST_PORT = Number(process.env.ANALYST_AGENT_PORT || 3002);
const WRITER_PORT = Number(process.env.WRITER_AGENT_PORT || 3003);
const PUBLIC_PORT = Number(process.env.PORT || 4000);

const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const RESEARCH_URL = `http://127.0.0.1:${RESEARCH_PORT}/run`;
const ANALYST_URL = `http://127.0.0.1:${ANALYST_PORT}/run`;
const WRITER_URL = `http://127.0.0.1:${WRITER_PORT}/run`;

const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 80_000);

const SYSTEM_PROMPTS = {
  research:
    'You are a research agent. Given a topic, find and summarize key facts, recent developments, and relevant data. Be thorough and factual. Return structured JSON.',
  analyst:
    'You are an analyst agent. Given raw research data, extract key insights, identify patterns, and provide analytical conclusions. Return structured JSON.',
  writer:
    'You are a writer agent. Given research and analysis, write a clear, well-structured report. Use markdown formatting. Make it professional and readable.',
};

const researchPrice = parsePrice(process.env.RESEARCH_AGENT_PRICE, '0.005');
const analystPrice = parsePrice(process.env.ANALYST_AGENT_PRICE, '0.003');
const writerPrice = parsePrice(process.env.WRITER_AGENT_PRICE, '0.008');

const sellerAddress = resolveSellerAddress();

function parsePrice(input: string | undefined, fallback: string): string {
  return `$${(Number(input || fallback) || Number(fallback)).toFixed(3)}`;
}

function resolveSellerAddress(): Address {
  const configured = process.env.SELLER_ADDRESS?.trim();
  if (configured) {
    if (!isAddress(configured)) {
      throw new Error('SELLER_ADDRESS is configured but invalid.');
    }
    return getAddress(configured);
  }

  const privateKey = process.env.PRIVATE_KEY?.trim();
  if (privateKey) {
    const normalized = (privateKey.startsWith('0x')
      ? privateKey
      : `0x${privateKey}`) as `0x${string}`;
    const account = privateKeyToAccount(normalized);
    console.warn(
      `[Boot] SELLER_ADDRESS is not set. Falling back to address derived from PRIVATE_KEY (${account.address}) for seller pay-to only.`,
    );
    return account.address;
  }

  throw new Error(
    'SELLER_ADDRESS is required when PRIVATE_KEY is not provided. Backend no longer signs buyer payments.',
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
      const payload = await withTimeout(run(req), AGENT_TIMEOUT_MS, `${name} agent`);
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

  // Simple SSE proxy for a single agent call. Frontend controls orchestration/payment.
  app.post('/run', async (req, res) => {
    const step = parseStep((req.body?.step as string | undefined) ?? 'research');
    const payload = req.body?.payload;
    const paymentSignature =
      (req.body?.paymentSignature as string | undefined) ??
      req.header('Payment-Signature') ??
      undefined;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // @ts-ignore
    res.flushHeaders?.();

    const sendEvent = (event: ProxyEvent) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (!step) {
      sendEvent({
        type: 'error',
        message: 'Invalid step. Use research, analyst, or writer.',
      });
      res.end();
      return;
    }

    try {
      sendEvent({ type: 'proxy_start', step });

      const result = await proxyAgentRun({
        step,
        method: 'POST',
        body: payload,
        paymentSignature,
      });

      if (result.paymentRequiredHeader) {
        sendEvent({
          type: 'payment_required',
          step,
          paymentRequiredHeader: result.paymentRequiredHeader,
        });
      }

      if (result.status >= 400 && result.status !== 402) {
        sendEvent({
          type: 'error',
          step,
          status: result.status,
          message:
            typeof result.data === 'string'
              ? result.data
              : getErrorMessage(result.data),
        });
      } else {
        sendEvent({
          type: 'proxy_response',
          step,
          status: result.status,
          transaction: decodeTransactionFromPaymentResponse(
            result.paymentResponseHeader,
          ),
          data: result.data,
        });
      }
    } catch (err) {
      sendEvent({
        type: 'error',
        step,
        message: getErrorMessage(err),
      });
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
    console.log(`[Boot] Seller address for x402 payouts: ${sellerAddress}`);
  });
}

start().catch((err) => {
  console.error('[Boot] Failed to start unified backend', err);
  process.exit(1);
});
