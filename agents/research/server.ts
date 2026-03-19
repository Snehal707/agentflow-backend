import express from 'express';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { createGatewayMiddleware } from '@circlefin/x402-batching/server';
import { callHermes } from '../../lib/hermes';
import { RESEARCH_SYSTEM_PROMPT } from '../../lib/agentPrompts';
import { fetchLiveData } from '../../lib/live-data';

dotenv.config();

const app = express();
app.use(express.json());
const HERMES_TIMEOUT_MS = Number(process.env.RESEARCH_HERMES_TIMEOUT_MS || 140_000);
const LIVE_DATA_TIMEOUT_MS = Number(process.env.RESEARCH_LIVE_DATA_TIMEOUT_MS || 5_000);

const port = Number(process.env.RESEARCH_AGENT_PORT || 3001);
let privateKey = process.env.PRIVATE_KEY?.trim() ?? '';
if (privateKey && !privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const price =
  process.env.RESEARCH_AGENT_PRICE !== undefined
    ? `$${process.env.RESEARCH_AGENT_PRICE}`
    : '$0.005';

const facilitatorUrl = process.env.FACILITATOR_URL || 'http://localhost:3000';
const sellerAddress =
  (process.env.SELLER_ADDRESS?.trim() as `0x${string}`) || account.address;
const gateway = createGatewayMiddleware({
  sellerAddress,
  facilitatorUrl,
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
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

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const runHandler = async (req: express.Request, res: express.Response) => {
  const requestId = `research_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  try {
    const task = (req.body?.task as string) ?? (req.query.task as string) ?? '';
    if (!task.trim()) {
      return res.status(400).json({ error: 'Task is required', requestId });
    }

    console.log(
      `[Research ${requestId}] ${req.method} /run taskLength=${task.length}`,
    );
    let liveData = '';
    try {
      liveData = await withTimeout(
        fetchLiveData(task),
        LIVE_DATA_TIMEOUT_MS,
        `Live data timed out after ${LIVE_DATA_TIMEOUT_MS / 1000}s`,
      );
    } catch (liveDataError) {
      console.warn(`[Research ${requestId}] Live data enrichment skipped:`, getErrorMessage(liveDataError));
    }
    const userMessage = liveData
      ? `LIVE DATA JSON (${new Date().toISOString()}):\n${liveData}\n\nUSER TASK:\n${task}\n\nUse the LIVE DATA JSON above for current figures and dated evidence. Prefer CoinGecko for token market data, DefiLlama for chain TVL and stablecoin liquidity, current-event article snapshots for geopolitical developments, Wikipedia for factual background, and DuckDuckGo only for supporting context.`
      : task;
    const result = await withTimeout(
      callHermes(RESEARCH_SYSTEM_PROMPT, userMessage),
      HERMES_TIMEOUT_MS,
      `Hermes timed out after ${HERMES_TIMEOUT_MS / 1000}s`,
    );
    console.log(
      `[Research ${requestId}] Completed in ${Date.now() - start}ms`,
    );
    res.json({ task, result });
  } catch (err) {
    const message = getErrorMessage(err);
    const statusCode = message.includes('timed out') ? 504 : 500;
    console.error(`[Research ${requestId}] Failed`, err);
    res.status(statusCode).json({
      error: 'Research agent failed',
      details: message,
      requestId,
    });
  }
};

app.get('/run', gateway.require(price), runHandler);
app.post('/run', gateway.require(price), runHandler);

app.listen(port, () => {
  console.log(`Research agent running on :${port}`);
});

