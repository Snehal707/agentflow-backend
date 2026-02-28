import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { getAddress, isAddress, type Address } from 'viem';

dotenv.config();

type AgentStep = 'research' | 'analyst' | 'writer';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || Number(process.env.UI_PORT) || 4000;
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL || 'https://gateway-api-testnet.circle.com/v1';
const GATEWAY_DOMAIN = Number(process.env.GATEWAY_DOMAIN || 26);

const RESEARCH_URL = process.env.RESEARCH_AGENT_URL || 'http://localhost:3001/run';
const ANALYST_URL = process.env.ANALYST_AGENT_URL || 'http://localhost:3002/run';
const WRITER_URL = process.env.WRITER_AGENT_URL || 'http://localhost:3003/run';

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Payment-Signature, Authorization',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Content-Type',
  );
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

function parseStep(raw: string | undefined): AgentStep | null {
  if (raw === 'research' || raw === 'analyst' || raw === 'writer') return raw;
  return null;
}

function getAgentUrl(step: AgentStep): string {
  if (step === 'research') return RESEARCH_URL;
  if (step === 'analyst') return ANALYST_URL;
  return WRITER_URL;
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

async function fetchGatewayBalanceForAddress(address: Address): Promise<{
  available: string;
  total: string;
}> {
  const response = await fetch(`${GATEWAY_API_BASE_URL}/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [{ depositor: address, domain: GATEWAY_DOMAIN }],
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
  return {
    available,
    total: (Number(available) + Number(withdrawing)).toString(),
  };
}

async function proxyAgentRun(params: {
  step: AgentStep;
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
    method: 'POST',
    headers,
    body: JSON.stringify(params.body ?? {}),
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

app.get('/gateway-balance', async (req, res) => {
  try {
    const addressQuery = req.query.address as string | undefined;
    if (!addressQuery || !isAddress(addressQuery)) {
      return res.status(400).json({ error: 'Valid address query parameter is required' });
    }
    const address = getAddress(addressQuery);
    const balance = await fetchGatewayBalanceForAddress(address);
    return res.json({
      address,
      balance: balance.available,
      formatted: balance.available,
      total: balance.total,
    });
  } catch (err) {
    console.error('gateway-balance error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.post('/deposit', (_req, res) => {
  res.status(410).json({
    success: false,
    error:
      'Deposit is client-side only now. Use MetaMask approve + depositFor from the frontend.',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/stack', async (_req, res) => {
  const facilitatorUrl = process.env.FACILITATOR_URL || 'http://localhost:3000';

  const check = async (url: string, paymentAllowed = false) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
      if (paymentAllowed && response.status === 402) return true;
      return false;
    } catch {
      return false;
    }
  };

  const [facilitator, research, analyst, writer] = await Promise.all([
    check(`${facilitatorUrl.replace(/\/$/, '')}/health`),
    check(RESEARCH_URL.split('?')[0] || RESEARCH_URL, true),
    check(ANALYST_URL.split('?')[0] || ANALYST_URL, true),
    check(WRITER_URL.split('?')[0] || WRITER_URL, true),
  ]);

  const ok = facilitator && research && analyst && writer;
  res.status(ok ? 200 : 503).json({ ok, facilitator, research, analyst, writer });
});

app.post('/agent/:step/run', async (req, res) => {
  const step = parseStep(req.params.step);
  if (!step) {
    return res.status(400).json({ error: 'Invalid step. Use research, analyst, or writer.' });
  }

  try {
    const result = await proxyAgentRun({
      step,
      body: req.body,
      paymentSignature: req.header('Payment-Signature') || undefined,
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
    console.error('agent proxy error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

// SSE endpoint is now a simple single-step proxy. Browser orchestrates all 3 steps.
app.post('/run', async (req, res) => {
  const step = parseStep((req.body?.step as string | undefined) ?? 'research');
  if (!step) {
    res.status(400).json({ error: 'Invalid step. Use research, analyst, or writer.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // @ts-ignore
  res.flushHeaders?.();

  const sendEvent = (event: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    sendEvent({ type: 'proxy_start', step });
    const result = await proxyAgentRun({
      step,
      body: req.body?.payload,
      paymentSignature:
        (req.body?.paymentSignature as string | undefined) ||
        req.header('Payment-Signature') ||
        undefined,
    });

    if (result.paymentRequiredHeader) {
      sendEvent({
        type: 'payment_required',
        step,
        paymentRequiredHeader: result.paymentRequiredHeader,
      });
    }

    sendEvent({
      type: result.status >= 400 && result.status !== 402 ? 'error' : 'proxy_response',
      step,
      status: result.status,
      data: result.data,
    });
  } catch (err) {
    sendEvent({ type: 'error', step, message: getErrorMessage(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.get('/', (_req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  res.sendFile(filePath);
});

const server = app.listen(PORT, () => {
  console.log(
    `[Boot] AgentFlow UI listening on :${PORT} (PORT=${process.env.PORT || 'unset'}, UI_PORT=${process.env.UI_PORT || 'unset'})`,
  );
});

server.on('error', (err) => {
  console.error('[Boot] UI server failed to start:', err);
});
