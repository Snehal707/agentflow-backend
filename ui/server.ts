import express, { type Request, type Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { getAddress, isAddress, type Address } from 'viem';
import {
  createUserWallet,
  getCircleWalletForUser,
  getOrCreateWalletSetId,
} from '../lib/circleWallet';
import { sendGAEvent } from '../lib/gaServer';
import { getWalletForUser, setWalletForUser } from '../lib/walletStore';
import { payProtectedResourceServer } from '../lib/x402ServerClient';

dotenv.config();

type AgentStep = 'research' | 'analyst' | 'writer';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || Number(process.env.UI_PORT) || 4000;
const CHAIN_ID = 5042002;
const GATEWAY_API_BASE_URL =
  process.env.GATEWAY_API_BASE_URL || 'https://gateway-api-testnet.circle.com/v1';
const GATEWAY_DOMAIN = Number(process.env.GATEWAY_DOMAIN || 26);

const RESEARCH_URL = process.env.RESEARCH_AGENT_URL || 'http://localhost:3001/run';
const ANALYST_URL = process.env.ANALYST_AGENT_URL || 'http://localhost:3002/run';
const WRITER_URL = process.env.WRITER_AGENT_URL || 'http://localhost:3003/run';
const researchPrice = parsePrice(process.env.RESEARCH_AGENT_PRICE, '0.005');
const analystPrice = parsePrice(process.env.ANALYST_AGENT_PRICE, '0.003');
const writerPrice = parsePrice(process.env.WRITER_AGENT_PRICE, '0.008');

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

function parsePrice(input: string | undefined, fallback: string): string {
  return `$${(Number(input || fallback) || Number(fallback)).toFixed(3)}`;
}

function getAgentResultText(data: { result?: string } | undefined | null): string {
  if (typeof data?.result === 'string' && data.result.trim()) {
    return data.result;
  }
  return JSON.stringify(data ?? {});
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
  method?: 'GET' | 'POST';
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
    method: params.method ?? 'POST',
    headers,
    body:
      (params.method ?? 'POST') === 'POST'
        ? JSON.stringify(params.body ?? {})
        : undefined,
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

const getBalanceHandler = async (req: Request, res: Response) => {
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
};

app.get('/balance', getBalanceHandler);
app.get('/gateway-balance', getBalanceHandler);

app.post('/wallet/create', async (req, res) => {
  try {
    const userAddress = (req.body?.userAddress as string | undefined) ?? '';
    if (!userAddress || !isAddress(userAddress)) {
      return res.status(400).json({ error: 'Valid userAddress is required.' });
    }

    const normalized = getAddress(userAddress);
    const existing = getWalletForUser(normalized);
    if (existing) {
      return res.json({
        userAddress: normalized,
        circleWalletId: existing.circleWalletId,
        circleWalletAddress: existing.circleWalletAddress,
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

app.get('/wallet/:address', (req, res) => {
  try {
    const addressParam = req.params.address;
    if (!addressParam || !isAddress(addressParam)) {
      return res.status(400).json({ error: 'Valid address parameter is required.' });
    }

    const normalized = getAddress(addressParam);
    const existing = getWalletForUser(normalized);
    if (!existing) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    return res.json({
      userAddress: normalized,
      circleWalletId: existing.circleWalletId,
      circleWalletAddress: existing.circleWalletAddress,
    });
  } catch (err) {
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.post('/wallet/fund-gateway', async (req, res) => {
  try {
    const userAddress = (req.body?.userAddress as string | undefined) ?? '';
    if (!userAddress || !isAddress(userAddress)) {
      return res.status(400).json({ error: 'Valid userAddress is required.' });
    }

    const normalized = getAddress(userAddress);

    let existing: { walletId: string; address: string };
    try {
      existing = getCircleWalletForUser(normalized);
    } catch {
      return res
        .status(404)
        .json({ error: 'Circle wallet not found for user', userAddress: normalized });
    }

    const gatewayBalance = await fetchGatewayBalanceForAddress(existing.address as Address);
    const current = Number(gatewayBalance.available || '0');

    if (Number.isNaN(current)) {
      return res
        .status(500)
        .json({ error: 'Invalid Gateway balance response', balance: gatewayBalance });
    }

    const { transferToGateway } = await import('../lib/circleWallet');
    const transferResult = await transferToGateway({
      walletId: existing.walletId,
      walletAddress: existing.address,
    });

    const refreshed = await fetchGatewayBalanceForAddress(existing.address as Address);
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

app.get('/circle-wallet/:userAddress', async (req, res) => {
  try {
    const userAddress = req.params.userAddress ?? '';
    if (!userAddress || !isAddress(userAddress)) {
      return res.status(400).json({ error: 'Valid userAddress is required.' });
    }

    const normalized = getAddress(userAddress);
    const existing = getWalletForUser(normalized);
    if (!existing) {
      return res
        .status(404)
        .json({ error: 'Circle wallet not found for user', userAddress: normalized });
    }

    const gatewayBalance = await fetchGatewayBalanceForAddress(
      existing.circleWalletAddress as Address,
    );
    const balance = Number(gatewayBalance.available || '0');

    return res.json({
      userAddress: normalized,
      circleWalletId: existing.circleWalletId,
      circleWalletAddress: existing.circleWalletAddress,
      gatewayBalance: balance,
      rawGatewayBalance: gatewayBalance,
    });
  } catch (err) {
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

const proxyHandler = async (req: Request, res: Response) => {
  const step = parseStep(req.params.step);
  if (!step) {
    return res.status(400).json({ error: 'Invalid step. Use research, analyst, or writer.' });
  }

  try {
    const result = await proxyAgentRun({
      step,
      method: req.method === 'GET' ? 'GET' : 'POST',
      body: req.method === 'GET' ? req.query : req.body,
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
};

app.get('/agent/:step/run', proxyHandler);
app.post('/agent/:step/run', proxyHandler);

app.post('/run', async (req, res) => {
  const task = (req.body?.task as string | undefined) ?? '';
  const userAddressInput = (req.body?.userAddress as string | undefined) ?? '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // @ts-ignore
  res.flushHeaders?.();

  const sendEvent = (event: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (!task.trim()) {
    sendEvent({ type: 'error', message: 'Task is required' });
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
  try {
    const normalized = getAddress(userAddressInput);
    const circleWallet = getCircleWalletForUser(normalized);
    circleWalletId = circleWallet.walletId;
    payerAddress = circleWallet.address as Address;
  } catch (err) {
    sendEvent({ type: 'error', message: getErrorMessage(err) });
    res.end();
    return;
  }

  try {
    await sendGAEvent('pipeline_started', {
      wallet_address: payerAddress,
      timestamp: Date.now(),
    });

    sendEvent({
      type: 'step_start',
      step: 'research',
      price: researchPrice,
    });

    const researchResult = await payProtectedResourceServer<
      { task?: string; result?: string },
      { task: string }
    >({
      url: RESEARCH_URL,
      method: 'POST',
      body: { task },
      circleWalletId,
      payer: payerAddress,
      chainId: CHAIN_ID,
    });

    const researchTx = researchResult.transaction;
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

    sendEvent({
      type: 'step_start',
      step: 'analyst',
      price: analystPrice,
    });

    const analystResult = await payProtectedResourceServer<
      { research?: string; result?: string },
      { research: string }
    >({
      url: ANALYST_URL,
      method: 'POST',
      body: { research: researchText },
      circleWalletId,
      payer: payerAddress,
      chainId: CHAIN_ID,
    });

    const analystTx = analystResult.transaction;
    const analysisText = getAgentResultText(analystResult.data);

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

    sendEvent({
      type: 'step_start',
      step: 'writer',
      price: writerPrice,
    });

    const writerResult = await payProtectedResourceServer<
      { research?: string; analysis?: string; result?: string },
      { research: string; analysis: string; task: string }
    >({
      url: WRITER_URL,
      method: 'POST',
      body: {
        research: researchText,
        analysis: analysisText,
        task,
      },
      circleWalletId,
      payer: payerAddress,
      chainId: CHAIN_ID,
    });

    const writerTx = writerResult.transaction;

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
      total: total.toFixed(3),
      researchPrice,
      analystPrice,
      writerPrice,
      researchTx,
      analystTx,
      writerTx,
    });

    sendEvent({
      type: 'report',
      markdown: writerResult.data.result || 'Writer agent returned no markdown output.',
    });

    await sendGAEvent('pipeline_complete', {
      wallet_address: payerAddress,
      total: total.toFixed(3),
      timestamp: Date.now(),
    });
  } catch (err) {
    sendEvent({ type: 'error', message: getErrorMessage(err) });
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
