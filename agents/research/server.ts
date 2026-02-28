import express from 'express';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { createGatewayMiddleware } from '@circlefin/x402-batching/server';
import { callHermes } from '../../lib/hermes';

dotenv.config();

const app = express();
app.use(express.json());
const HERMES_TIMEOUT_MS = Number(process.env.RESEARCH_HERMES_TIMEOUT_MS || 80_000);

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

const today = new Date().toISOString().split('T')[0];
const SYSTEM_PROMPT = `Today's date is ${today}. You are a research agent. Given a topic, find and summarize key facts, recent developments, and relevant data. Be thorough and factual. Return structured JSON.`;

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
    const result = await withTimeout(
      callHermes(SYSTEM_PROMPT, task),
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

