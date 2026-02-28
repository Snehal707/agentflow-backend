import dotenv from 'dotenv';
import { GatewayClient } from '@circlefin/x402-batching/client';
import { callHermes } from './hermes';

dotenv.config();

const PAYMENT_TIMEOUT_MS = 90_000; // 90s - Hermes can take 30-60s

type OrchestratorError = Error & { step?: OrchestratorStep; cause?: unknown };

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${ms / 1000}s. Ensure facilitator (port 3000) and all agents (3001-3003) are running.`,
        ),
      );
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

export type OrchestratorStep = 'research' | 'analyst' | 'writer';

export type StepEvent =
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

export interface OrchestratorReceipt {
  total: string;
  researchPrice: string;
  analystPrice: string;
  writerPrice: string;
  researchTx: string;
  analystTx: string;
  writerTx: string;
}

export interface OrchestratorResult {
  report: string;
  summary: string;
  receipt: OrchestratorReceipt;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return String(err);

  const data = err as Record<string, unknown>;
  const parts: string[] = [];
  const maybeCode = data.code;
  const maybeStatus = data.status;
  const maybeReason = data.reason;
  const maybeError = data.error;

  if (typeof maybeCode === 'string') parts.push(`code=${maybeCode}`);
  if (typeof maybeStatus === 'number' || typeof maybeStatus === 'string') {
    parts.push(`status=${maybeStatus}`);
  }
  if (typeof maybeReason === 'string') parts.push(`reason=${maybeReason}`);
  if (typeof maybeError === 'string') parts.push(maybeError);

  if (parts.length > 0) return parts.join(' | ');

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function wrapStepError(
  step: OrchestratorStep,
  context: string,
  cause: unknown,
): OrchestratorError {
  const message = `${context}: ${getErrorMessage(cause)}`;
  const err = new Error(message) as OrchestratorError;
  err.step = step;
  err.cause = cause;
  return err;
}

export async function runOrchestrator(
  task: string,
  onEvent?: (e: StepEvent) => void,
): Promise<OrchestratorResult> {
  if (!task) {
    throw new Error('Task is required');
  }

  let privateKey = process.env.PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error('PRIVATE_KEY is not set in environment.');
  }
  if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;

  const client = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: privateKey as `0x${string}`,
  });

  const researchUrl =
    process.env.RESEARCH_AGENT_URL || 'http://localhost:3001/run';
  const analystUrl =
    process.env.ANALYST_AGENT_URL || 'http://localhost:3002/run';
  const writerUrl =
    process.env.WRITER_AGENT_URL || 'http://localhost:3003/run';

  const researchPrice = Number(process.env.RESEARCH_AGENT_PRICE || '0.005');
  const analystPrice = Number(process.env.ANALYST_AGENT_PRICE || '0.003');
  const writerPrice = Number(process.env.WRITER_AGENT_PRICE || '0.008');

  onEvent?.({
    type: 'step_start',
    step: 'research',
    price: researchPrice.toFixed(3),
  });

  let researchJson: { task?: string; result?: string };
  let researchTx: string;
  try {
    console.log(`[Orchestrator:research] Paying ${researchUrl}`);
    const researchStart = Date.now();
    const response = (await withTimeout(
      client.pay<{ task?: string; result?: string }>(researchUrl, {
        method: 'POST',
        body: { task },
      }),
      PAYMENT_TIMEOUT_MS,
      'Research agent',
    )) as { data: { task?: string; result?: string }; transaction: string };
    researchJson = response.data;
    researchTx = response.transaction;
    console.log(
      `[Orchestrator:research] Completed in ${Date.now() - researchStart}ms tx=${researchTx}`,
    );
  } catch (err) {
    console.error('[Orchestrator:research] Failed', err);
    throw wrapStepError(
      'research',
      `Research step failed for ${researchUrl}`,
      err,
    );
  }

  onEvent?.({
    type: 'step_complete',
    step: 'research',
    tx: researchTx,
    amount: researchPrice.toFixed(3),
  });

  onEvent?.({
    type: 'step_start',
    step: 'analyst',
    price: analystPrice.toFixed(3),
  });

  let analystJson: { research?: string; result?: string };
  let analystTx: string;
  try {
    console.log(`[Orchestrator:analyst] Paying ${analystUrl}`);
    const analystStart = Date.now();
    const response = (await withTimeout(
      client.pay<{ research?: string; result?: string }>(analystUrl, {
        method: 'POST',
        body: { research: JSON.stringify(researchJson) },
      }),
      PAYMENT_TIMEOUT_MS,
      'Analyst agent',
    )) as { data: { research?: string; result?: string }; transaction: string };
    analystJson = response.data;
    analystTx = response.transaction;
    console.log(
      `[Orchestrator:analyst] Completed in ${Date.now() - analystStart}ms tx=${analystTx}`,
    );
  } catch (err) {
    console.error('[Orchestrator:analyst] Failed', err);
    throw wrapStepError('analyst', `Analyst step failed for ${analystUrl}`, err);
  }

  onEvent?.({
    type: 'step_complete',
    step: 'analyst',
    tx: analystTx,
    amount: analystPrice.toFixed(3),
  });

  onEvent?.({
    type: 'step_start',
    step: 'writer',
    price: writerPrice.toFixed(3),
  });

  let writerJson: {
    research?: string;
    analysis?: string;
    result?: string;
  };
  let writerTx: string;
  try {
    console.log(`[Orchestrator:writer] Paying ${writerUrl}`);
    const writerStart = Date.now();
    const response = (await withTimeout(
      client.pay<{
        research?: string;
        analysis?: string;
        result?: string;
      }>(writerUrl, {
        method: 'POST',
        body: {
          research: JSON.stringify(researchJson),
          analysis: JSON.stringify(analystJson),
        },
      }),
      PAYMENT_TIMEOUT_MS,
      'Writer agent',
    )) as {
      data: { research?: string; analysis?: string; result?: string };
      transaction: string;
    };
    writerJson = response.data;
    writerTx = response.transaction;
    console.log(
      `[Orchestrator:writer] Completed in ${Date.now() - writerStart}ms tx=${writerTx}`,
    );
  } catch (err) {
    console.error('[Orchestrator:writer] Failed', err);
    throw wrapStepError('writer', `Writer step failed for ${writerUrl}`, err);
  }

  onEvent?.({
    type: 'step_complete',
    step: 'writer',
    tx: writerTx,
    amount: writerPrice.toFixed(3),
  });

  const totalPaid = researchPrice + analystPrice + writerPrice;

  const receipt: OrchestratorReceipt = {
    total: totalPaid.toFixed(3),
    researchPrice: researchPrice.toFixed(3),
    analystPrice: analystPrice.toFixed(3),
    writerPrice: writerPrice.toFixed(3),
    researchTx,
    analystTx,
    writerTx,
  };

  onEvent?.({
    type: 'receipt',
    total: receipt.total,
    researchTx,
    analystTx,
    writerTx,
  });

  const reportMarkdown = writerJson.result ?? '';
  const orchestrationSummary = await callHermes(
    'You are an orchestrator agent. Given a user task and the outputs of research, analyst, and writer agents, summarize what was done and highlight key insights.',
    JSON.stringify({ task, researchJson, analystJson, writerJson }),
  );

  onEvent?.({
    type: 'report',
    markdown: reportMarkdown,
    summary: orchestrationSummary,
  });

  return {
    report: reportMarkdown,
    summary: orchestrationSummary,
    receipt,
  };
}
