import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import {
  OrchestratorStep,
  runOrchestrator,
  StepEvent,
} from '../lib/orchestrator';
import { GatewayClient } from '@circlefin/x402-batching/client';

dotenv.config();

const app = express();
app.use(express.json());

const PORT =
  Number(process.env.PORT) || Number(process.env.UI_PORT) || 4000;

// CORS for Next.js frontend
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function getGatewayClient(): GatewayClient | null {
  let privateKey = process.env.PRIVATE_KEY?.trim();
  if (!privateKey) return null;
  if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
  return new GatewayClient({
    chain: 'arcTestnet',
    privateKey: privateKey as `0x${string}`,
  });
}

app.get('/gateway-balance', async (req, res) => {
  try {
    const client = getGatewayClient();
    if (!client) {
      return res.status(500).json({ error: 'PRIVATE_KEY not configured' });
    }
    const address = (req.query.address as string) || undefined;
    const balances = await client.getBalances(
      address as `0x${string}` | undefined,
    );
    return res.json({
      balance: balances.gateway.formattedAvailable,
      formatted: balances.gateway.formattedAvailable,
      total: balances.gateway.formattedTotal,
    });
  } catch (err) {
    console.error('gateway-balance error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch balance',
    });
  }
});

app.post('/deposit', async (req, res) => {
  try {
    const client = getGatewayClient();
    if (!client) {
      return res.status(500).json({ error: 'PRIVATE_KEY not configured' });
    }
    const amount = (req.body?.amount as string) || '1';
    const depositor = req.body?.depositor as string | undefined;
    if (depositor) {
      const result = await client.depositFor(
        amount,
        depositor as `0x${string}`,
      );
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
    console.error('deposit error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Deposit failed',
      success: false,
    });
  }
});

app.options('*', (_req, res) => res.sendStatus(204));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/stack', async (_req, res) => {
  const facilitatorUrl =
    process.env.FACILITATOR_URL || 'http://localhost:3000';
  const researchUrl =
    process.env.RESEARCH_AGENT_URL || 'http://localhost:3001/run';
  const analystUrl =
    process.env.ANALYST_AGENT_URL || 'http://localhost:3002/run';
  const writerUrl =
    process.env.WRITER_AGENT_URL || 'http://localhost:3003/run';

  const check = async (url: string, expectOk = true) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return expectOk ? r.ok : r.status === 402 || r.ok; // 402 = agent up, payment required
    } catch {
      return false;
    }
  };

  const [facilitator, research, analyst, writer] = await Promise.all([
    check(`${facilitatorUrl.replace(/\/$/, '')}/health`),
    check(researchUrl.split('?')[0] || researchUrl, false),
    check(analystUrl.split('?')[0] || analystUrl, false),
    check(writerUrl.split('?')[0] || writerUrl, false),
  ]);

  const ok = facilitator && research && analyst && writer;
  res.status(ok ? 200 : 503).json({
    ok,
    facilitator,
    research,
    analyst,
    writer,
  });
});

app.get('/', (_req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  res.sendFile(filePath);
});

function getErrorStep(err: unknown): OrchestratorStep | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const step = (err as { step?: unknown }).step;
  if (step === 'research' || step === 'analyst' || step === 'writer') {
    return step;
  }
  return undefined;
}

app.post('/run', async (req, res) => {
  const task = (req.body?.task as string | undefined)?.trim() ?? '';
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Flush headers for some proxies
  // @ts-ignore flushHeaders is available in Express response
  res.flushHeaders?.();

  let clientDisconnected = false;
  req.on('aborted', () => {
    clientDisconnected = true;
    console.warn(`[UI ${runId}] client aborted request`);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      console.warn(`[UI ${runId}] SSE stream closed before completion`);
    }
  });

  const sendEvent = (event: StepEvent) => {
    if (clientDisconnected || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      clientDisconnected = true;
      console.error(`[UI ${runId}] Failed to write SSE event`, err);
    }
  };

  const endStream = () => {
    if (res.writableEnded) return;
    try {
      res.end();
    } catch (err) {
      console.error(`[UI ${runId}] Failed to close SSE stream`, err);
    }
  };

  if (!task) {
    sendEvent({ type: 'error', message: 'Task is required' });
    endStream();
    return;
  }

  try {
    console.log(`[UI ${runId}] Starting orchestrator run`);
    await runOrchestrator(task, (event) => {
      sendEvent(event);
    });
  } catch (err) {
    console.error(`[UI ${runId}] Orchestrator failed`, err);
    const message =
      err instanceof Error ? err.message : 'Unexpected error in orchestrator';
    const step = getErrorStep(err);
    sendEvent({ type: 'error', message, step });
  } finally {
    endStream();
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`AgentFlow UI listening on http://localhost:${PORT}`);
});

