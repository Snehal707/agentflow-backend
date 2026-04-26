import { Router, type Request, type Response } from 'express';
import { createPublicClient, decodeFunctionData, defineChain, getAddress, http, parseUnits } from 'viem';
import { ARC } from '../lib/arc-config';
import { authMiddleware, type JWTPayload } from '../lib/auth';
import { adminDb, getRedis } from '../db/client';
import { normalizeHandle, resolveHandle } from '../lib/handles';
import {
  cleanRegistryName,
  getAgentPayRegistryAddress,
  getNameInfoOnChain,
  getOwnerRegisteredName,
  isNameAvailableOnChain,
  readRegistrationFee,
  readRenewalFee,
  resolveRegistryName,
} from '../lib/agentpay-registry';
import {
  executeUsdcTransfer,
  explorerLinkTx,
  extractTxId,
} from '../lib/agentpay-transfer';
import { incrementTxCount } from '../lib/tx-counter';
import { looksLikeAddress, resolvePayee } from '../lib/agentpay-payee';
import {
  executeTransaction,
  getOrCreateUserAgentWallet,
  waitForTransaction,
} from '../lib/dcw';
import {
  cancelScheduledPayment,
  createScheduledPayment,
  getScheduledPayments,
  parseSchedulePhrase,
  type ScheduleType,
} from '../lib/scheduled-payments';
import { canonicalRedisSessionId, pendingRedisKeyCandidates } from '../lib/chatSessionRedis';
import { markInvoicePaidFromRequest } from '../lib/invoice-agentpay';

const ARC_USDC = '0x3600000000000000000000000000000000000000' as const;

const router = Router();

export { explorerLinkTx };

function normalizeWallet(req: unknown): string {
  const auth = (req as any).auth as JWTPayload;
  return auth.walletAddress;
}

const AGENTPAY_SLUG = 'agentpay';
const AGENTPAY_PENDING_PREFIX = 'agentpay:pending:';
const SCHEDULE_PENDING_PREFIX = 'scheduled_payment:pending:';

type AgentPayPendingPayload = {
  tool: 'agentpay_send';
  to: string;
  resolvedAddress?: string | null;
  amount: string;
  remark?: string;
  walletAddress: string;
};

type SchedulePendingPayload = {
  tool: 'schedule_payment';
  walletAddress: string;
  to: string;
  resolvedAddress?: string | null;
  amount: string;
  schedule: string;
  remark?: string;
};

function schedulePendingKey(sessionId: string): string {
  return `${SCHEDULE_PENDING_PREFIX}${canonicalRedisSessionId(sessionId)}`;
}

/** Supabase PostgREST `.or()`: row touches user DCW or EOA (legacy sender / handle payee). */
function agentPayWalletOrFilter(dcwAddr: string, eoaAddr: string): string {
  return `from_wallet.eq.${dcwAddr},to_wallet.eq.${dcwAddr},from_wallet.eq.${eoaAddr},to_wallet.eq.${eoaAddr}`;
}

function pendingPaymentKey(sessionId: string): string {
  return `${AGENTPAY_PENDING_PREFIX}${canonicalRedisSessionId(sessionId)}`;
}

function agentPayDirection(
  row: { from_wallet: unknown; to_wallet: unknown },
  dcwAddr: string,
  eoaAddr: string,
): 'in' | 'out' {
  const to = String(row.to_wallet ?? '').toLowerCase();
  const from = String(row.from_wallet ?? '').toLowerCase();
  const d = dcwAddr.toLowerCase();
  const e = eoaAddr.toLowerCase();
  if (to === d || to === e) return 'in';
  if (from === d || from === e) return 'out';
  return 'out';
}

function workbookToXlsxBuffer(XLSX: typeof import('xlsx'), wb: import('xlsx').WorkBook): Buffer {
  const raw = XLSX.write(wb, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  } as Parameters<typeof XLSX.write>[1]);
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw as Uint8Array);
}

/** Binary .xlsx: set headers once, then end with buffer (avoid res.send encoding issues). */
function sendBinaryXlsxResponse(res: Response, buf: Buffer): void {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', 'attachment; filename="agentpay-transactions.xlsx"');
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

async function sendAgentPayEmptyExportWorkbook(res: Response): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([{ Date: '', Note: 'No agent wallet' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  const buf = workbookToXlsxBuffer(XLSX, wb);
  sendBinaryXlsxResponse(res, buf);
}

router.get('/name/check/:name', async (req, res) => {
  try {
    if (!getAgentPayRegistryAddress()) {
      return res.status(503).json({ error: 'AgentPay registry not configured' });
    }
    const raw = String(req.params.name ?? '').trim();
    const clean = cleanRegistryName(raw);
    const available = clean ? await isNameAvailableOnChain(clean) : false;
    const display = clean ? `${clean}.arc` : raw;
    const feeWei = await readRegistrationFee();
    const registrationFeeUsdc = Number(feeWei) / 1e6;
    return res.json({ available, name: display, registrationFeeUsdc });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'name check failed' });
  }
});

router.get('/name/resolve/:name', async (req, res) => {
  try {
    const resolved = await resolveRegistryName(String(req.params.name ?? ''));
    if (!resolved) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json({ address: resolved });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'resolve failed' });
  }
});

router.post('/name/register', authMiddleware, async (req, res) => {
  try {
    const regAddr = getAgentPayRegistryAddress();
    if (!regAddr) {
      return res.status(503).json({ error: 'AgentPay registry not configured' });
    }
    const authAddr = getAddress(normalizeWallet(req));
    const rawName = String(req.body?.name ?? '').trim();
    const bodyDcw = String(req.body?.dcwWallet ?? '').trim();
    const clean = cleanRegistryName(rawName);
    if (clean.length < 3 || clean.length > 20) {
      return res.status(400).json({ error: 'Name must be 3–20 characters (a-z, 0-9)' });
    }
    if (!/^[a-z0-9]+$/.test(clean)) {
      return res.status(400).json({ error: 'Invalid characters. Use a-z and 0-9 only' });
    }
    const ua = await getOrCreateUserAgentWallet(authAddr);
    const dcw = getAddress(ua.address as `0x${string}`);
    if (bodyDcw && getAddress(bodyDcw).toLowerCase() !== dcw.toLowerCase()) {
      return res.status(400).json({ error: 'dcwWallet must match your agent wallet' });
    }
    if (!(await isNameAvailableOnChain(clean))) {
      return res.status(400).json({ error: 'Name not available' });
    }
    const fee = await readRegistrationFee();
    const feeUsdc = Number(fee) / 1e6;

    const approveTx = await executeTransaction({
      walletId: ua.wallet_id,
      contractAddress: ARC_USDC,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [regAddr, fee.toString()],
      feeLevel: 'HIGH',
      usdcAmount: feeUsdc,
    });
    const approveId = extractTxId(approveTx);
    if (!approveId) {
      return res.status(500).json({ error: 'Approve transaction id missing' });
    }
    const approveDone = await waitForTransaction(approveId, 'agentpay-registry-approve');
    if (approveDone.state !== 'COMPLETE') {
      return res.status(500).json({
        error: approveDone.errorReason || 'USDC approve failed',
      });
    }

    const regTx = await executeTransaction({
      walletId: ua.wallet_id,
      contractAddress: regAddr,
      abiFunctionSignature: 'register(string,address)',
      abiParameters: [clean, dcw],
      feeLevel: 'HIGH',
      usdcAmount: feeUsdc,
    });
    const regId = extractTxId(regTx);
    if (!regId) {
      return res.status(500).json({ error: 'Register transaction id missing' });
    }
    const regDone = await waitForTransaction(regId, 'agentpay-registry-register');
    if (regDone.state !== 'COMPLETE' || !regDone.txHash) {
      return res.status(500).json({
        error: regDone.errorReason || 'Register failed',
      });
    }

    return res.json({ txHash: regDone.txHash, name: `${clean}.arc` });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'register failed' });
  }
});

router.get('/name/my', authMiddleware, async (req, res) => {
  try {
    if (!getAgentPayRegistryAddress()) {
      return res.json({ name: null, expiresAt: null });
    }
    const authAddr = getAddress(normalizeWallet(req));
    const ua = await getOrCreateUserAgentWallet(authAddr);
    const registered = await readRegisteredArcNameForOwner(
      getAddress(ua.address as `0x${string}`),
    );
    return res.json(registered);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'my name failed' });
  }
});

async function readRegisteredArcNameForOwner(owner: `0x${string}`): Promise<{
  name: string | null;
  expiresAt: string | null;
}> {
  const n = await getOwnerRegisteredName(owner);
  let expiresAt: string | null = null;
  if (n) {
    const info = await getNameInfoOnChain(n);
    if (info && Array.isArray(info) && info[2] !== undefined) {
      expiresAt = new Date(Number(info[2] as bigint) * 1000).toISOString();
    }
  }
  return { name: n ? `${n}.arc` : null, expiresAt };
}

router.post('/name/renew', authMiddleware, async (req, res) => {
  try {
    const regAddr = getAgentPayRegistryAddress();
    if (!regAddr) {
      return res.status(503).json({ error: 'AgentPay registry not configured' });
    }
    const authAddr = getAddress(normalizeWallet(req));
    const ua = await getOrCreateUserAgentWallet(authAddr);
    const fee = await readRenewalFee();
    const feeUsdc = Number(fee) / 1e6;

    const approveTx = await executeTransaction({
      walletId: ua.wallet_id,
      contractAddress: ARC_USDC,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [regAddr, fee.toString()],
      feeLevel: 'HIGH',
      usdcAmount: feeUsdc,
    });
    const approveId = extractTxId(approveTx);
    if (!approveId) {
      return res.status(500).json({ error: 'Approve transaction id missing' });
    }
    const approveDone = await waitForTransaction(approveId, 'agentpay-registry-renew-approve');
    if (approveDone.state !== 'COMPLETE') {
      return res.status(500).json({
        error: approveDone.errorReason || 'USDC approve failed',
      });
    }

    const renewTx = await executeTransaction({
      walletId: ua.wallet_id,
      contractAddress: regAddr,
      abiFunctionSignature: 'renew()',
      abiParameters: [],
      feeLevel: 'HIGH',
      usdcAmount: feeUsdc,
    });
    const renewId = extractTxId(renewTx);
    if (!renewId) {
      return res.status(500).json({ error: 'Renew transaction id missing' });
    }
    const renewDone = await waitForTransaction(renewId, 'agentpay-registry-renew');
    if (renewDone.state !== 'COMPLETE' || !renewDone.txHash) {
      return res.status(500).json({
        error: renewDone.errorReason || 'Renew failed',
      });
    }

    const rawName = await getOwnerRegisteredName(getAddress(ua.address as `0x${string}`));
    let newExpiry: string | undefined;
    if (rawName) {
      const info = await getNameInfoOnChain(rawName);
      if (info && Array.isArray(info) && info[2] !== undefined) {
        newExpiry = new Date(Number(info[2] as bigint) * 1000).toISOString();
      }
    }
    return res.json({ txHash: renewDone.txHash, newExpiry });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'renew failed' });
  }
});

router.put('/name/dcw', authMiddleware, async (req, res) => {
  try {
    const regAddr = getAgentPayRegistryAddress();
    if (!regAddr) {
      return res.status(503).json({ error: 'AgentPay registry not configured' });
    }
    const authAddr = getAddress(normalizeWallet(req));
    const raw = String(req.body?.newDcwWallet ?? '').trim();
    if (!raw) {
      return res.status(400).json({ error: 'newDcwWallet is required' });
    }
    const newDcw = getAddress(raw);
    const ua = await getOrCreateUserAgentWallet(authAddr);

    const tx = await executeTransaction({
      walletId: ua.wallet_id,
      contractAddress: regAddr,
      abiFunctionSignature: 'updateDCW(address)',
      abiParameters: [newDcw],
      feeLevel: 'HIGH',
    });
    const txId = extractTxId(tx);
    if (!txId) {
      return res.status(500).json({ error: 'Transaction id missing' });
    }
    const done = await waitForTransaction(txId, 'agentpay-registry-update-dcw');
    if (done.state !== 'COMPLETE' || !done.txHash) {
      return res.status(500).json({ error: done.errorReason || 'updateDCW failed' });
    }
    return res.json({ txHash: done.txHash });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'update dcw failed' });
  }
});

router.get('/context', authMiddleware, async (req, res) => {
  try {
    const w = getAddress(normalizeWallet(req));
    const ua = await getOrCreateUserAgentWallet(w);
    const userAgentWalletAddress = getAddress(ua.address as `0x${string}`);
    const { data, error } = await adminDb
      .from('users')
      .select('arc_handle')
      .eq('wallet_address', w)
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    const chainArc = getAgentPayRegistryAddress()
      ? await readRegisteredArcNameForOwner(userAgentWalletAddress).catch(() => ({
          name: null,
          expiresAt: null,
        }))
      : { name: null, expiresAt: null };
    return res.json({
      walletAddress: w,
      userAgentWalletAddress,
      arc_handle: data?.arc_handle ? String(data.arc_handle) : null,
      chain_arc_name: chainArc.name,
      chain_arc_expires_at: chainArc.expiresAt,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'context failed' });
  }
});

router.post('/send', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const rawTo = String(req.body?.toAddress ?? '').trim();
    const amount = Number(req.body?.amount);
    const remarkRaw = String(req.body?.remark ?? '').trim();
    const remark = remarkRaw ? remarkRaw.slice(0, 100) : null;

    if (!rawTo) {
      return res.status(400).json({ error: 'toAddress is required' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const toResolved = await resolvePayee(rawTo, authAddr);
    const { txHash } = await executeUsdcTransfer({
      payerEoa: authAddr,
      toAddress: toResolved,
      amountUsdc: amount,
      remark,
      actionType: 'agentpay_send',
    });

    await incrementTxCount('agentpay');

    return res.json({
      txHash,
      explorerLink: explorerLinkTx(txHash),
    });
  } catch (e: any) {
    const msg = e?.message ?? 'send failed';
    if (typeof msg === 'string' && msg.includes('not registered on AgentPay')) {
      return res.status(400).json({ error: msg });
    }
    if (typeof msg === 'string' && msg.includes('Agent wallet not ready')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

router.post('/brain/preview', async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  const walletAddress = String(req.body?.walletAddress ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  const resolvedAddressRaw = String(req.body?.resolvedAddress ?? '').trim();
  const amount = String(req.body?.amount ?? '').trim();
  const remark = String(req.body?.remark ?? '').trim();

  if (!sessionId || !walletAddress || !to || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const payload: AgentPayPendingPayload = {
      tool: 'agentpay_send',
      to,
      resolvedAddress: resolvedAddressRaw || null,
      amount,
      remark,
      walletAddress,
    };
    await getRedis().set(pendingPaymentKey(sessionId), JSON.stringify(payload), 'EX', 300);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Failed to store pending payment' });
  }
});

router.post('/brain/execute', authMiddleware, async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    let pendingKeyUsed: string | null = null;
    let raw: string | null = null;
    for (const key of pendingRedisKeyCandidates(AGENTPAY_PENDING_PREFIX, sessionId)) {
      raw = await getRedis().get(key);
      if (raw) {
        pendingKeyUsed = key;
        break;
      }
    }
    if (!raw || !pendingKeyUsed) {
      return res.status(404).json({ error: 'No pending payment found' });
    }

    const pending = JSON.parse(raw) as AgentPayPendingPayload;
    const userAddress = getAddress(normalizeWallet(req));
    const toResolved = await resolvePayee(pending.resolvedAddress || pending.to, userAddress);
    const amountNumber = Number(pending.amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({ error: 'Invalid pending payment amount' });
    }

    const { txHash } = await executeUsdcTransfer({
      payerEoa: userAddress,
      toAddress: toResolved,
      amountUsdc: amountNumber,
      remark: pending.remark ? String(pending.remark).slice(0, 100) : null,
      actionType: 'agentpay_send',
    });

    await incrementTxCount('agentpay');

    await getRedis().del(pendingKeyUsed);

    return res.json({
      ok: true,
      txHash,
      explorerLink: explorerLinkTx(txHash),
    });
  } catch (e: any) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : e?.message ?? 'Payment failed',
    });
  }
});

router.post('/schedule/brain/preview', async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  const walletAddress = String(req.body?.walletAddress ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  const amount = String(req.body?.amount ?? '').trim();
  const schedule = String(req.body?.schedule ?? '').trim();
  const remark = String(req.body?.remark ?? '').trim();
  const resolvedAddressRaw = String(req.body?.resolvedAddress ?? '').trim();

  if (!sessionId || !walletAddress || !to || !amount || !schedule) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sched = parseSchedulePhrase(schedule);
  if (!sched) {
    return res.status(400).json({ error: 'Could not parse schedule phrase' });
  }

  try {
    const payload: SchedulePendingPayload = {
      tool: 'schedule_payment',
      walletAddress,
      to,
      resolvedAddress: resolvedAddressRaw || null,
      amount,
      schedule,
      remark: remark ? remark.slice(0, 500) : undefined,
    };
    await getRedis().set(schedulePendingKey(sessionId), JSON.stringify(payload), 'EX', 900);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Failed to store pending schedule' });
  }
});

router.post('/schedule/brain/execute', authMiddleware, async (req, res) => {
  const sessionId = String(req.body?.sessionId ?? '').trim();
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    let scheduleKeyUsed: string | null = null;
    let raw: string | null = null;
    for (const key of pendingRedisKeyCandidates(SCHEDULE_PENDING_PREFIX, sessionId)) {
      raw = await getRedis().get(key);
      if (raw) {
        scheduleKeyUsed = key;
        break;
      }
    }
    if (!raw || !scheduleKeyUsed) {
      return res.status(404).json({ error: 'No pending schedule found' });
    }

    const pending = JSON.parse(raw) as SchedulePendingPayload;
    const userAddress = getAddress(normalizeWallet(req));
    if (getAddress(pending.walletAddress).toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Wallet does not match pending schedule' });
    }

    const sched = parseSchedulePhrase(pending.schedule);
    if (!sched) {
      return res.status(400).json({ error: 'Invalid stored schedule phrase' });
    }

    const toResolved = await resolvePayee(pending.resolvedAddress || pending.to, userAddress);
    const amountNum = Number(pending.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const row = await createScheduledPayment({
      walletAddress: userAddress,
      to: pending.to,
      resolvedAddress: toResolved,
      amount: String(amountNum),
      remark: pending.remark ?? null,
      scheduleType: sched.scheduleType,
      scheduleValue: sched.scheduleValue,
    });

    await getRedis().del(scheduleKeyUsed);

    return res.json({
      ok: true,
      id: row.id,
      nextRun: row.next_run,
    });
  } catch (e: any) {
    const msg = e?.message ?? 'schedule execute failed';
    if (typeof msg === 'string' && msg.includes('not registered on AgentPay')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

async function handleCreatePaymentRequest(
  req: Request,
  res: Response,
  payeeAddr: `0x${string}`,
): Promise<void> {
  try {
    const fromRaw = String(req.body?.fromWallet ?? '').trim();
    const amount = Number(req.body?.amount);
    const remark = String(req.body?.remark ?? '').trim().slice(0, 500) || null;

    if (!fromRaw) {
      res.status(400).json({ error: 'fromWallet is required' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }

    const fromResolved = await resolvePayee(fromRaw, payeeAddr);
    if (fromResolved.toLowerCase() === payeeAddr.toLowerCase()) {
      res.status(400).json({ error: 'Cannot request from yourself' });
      return;
    }

    const { data, error } = await adminDb
      .from('payment_requests')
      .insert({
        from_wallet: fromResolved,
        to_wallet: payeeAddr,
        amount,
        remark,
        status: 'pending',
        initiated_by: payeeAddr,
      })
      .select('id')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ requestId: data?.id });
  } catch (e: any) {
    const msg = e?.message ?? 'request failed';
    if (typeof msg === 'string' && msg.includes('not registered on AgentPay')) {
      res.status(400).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

function resolveScheduleFromBody(body: Record<string, unknown>): {
  scheduleType: ScheduleType;
  scheduleValue: string;
} | null {
  const st = String(body?.scheduleType ?? '').trim();
  const sv = String(body?.scheduleValue ?? '').trim();
  if (st === 'monthly_day' || st === 'weekly_day' || st === 'daily') {
    if (st === 'daily') {
      return { scheduleType: 'daily', scheduleValue: sv || 'daily' };
    }
    if (!sv) {
      return null;
    }
    if (st === 'weekly_day') {
      return { scheduleType: 'weekly_day', scheduleValue: sv.toLowerCase() };
    }
    const dom = Math.min(31, Math.max(1, parseInt(sv, 10) || 1));
    return { scheduleType: 'monthly_day', scheduleValue: String(dom) };
  }
  const phrase = String(body?.schedule ?? '').trim();
  if (!phrase) {
    return null;
  }
  return parseSchedulePhrase(phrase);
}

async function handleSchedulePost(
  req: Request,
  res: Response,
  payerWallet: `0x${string}`,
): Promise<void> {
  try {
    const toRaw = String(req.body?.to ?? '').trim();
    const amount = Number(req.body?.amount);
    const remark = String(req.body?.remark ?? '').trim().slice(0, 500) || null;
    if (!toRaw) {
      res.status(400).json({ error: 'to is required' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    const sched = resolveScheduleFromBody((req.body ?? {}) as Record<string, unknown>);
    if (!sched) {
      res.status(400).json({
        error: 'Invalid or missing schedule. Provide schedule string or scheduleType + scheduleValue.',
      });
      return;
    }
    const resolvedAddress = await resolvePayee(toRaw, payerWallet);
    const row = await createScheduledPayment({
      walletAddress: payerWallet,
      to: toRaw,
      resolvedAddress,
      amount: String(amount),
      remark,
      scheduleType: sched.scheduleType,
      scheduleValue: sched.scheduleValue,
    });
    res.json({ id: row.id, nextRun: row.next_run });
  } catch (e: any) {
    const msg = e?.message ?? 'schedule failed';
    if (typeof msg === 'string' && msg.includes('not registered on AgentPay')) {
      res.status(400).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }
}

async function handleScheduleList(
  _req: Request,
  res: Response,
  payerWallet: `0x${string}`,
): Promise<void> {
  try {
    const rows = await getScheduledPayments(payerWallet);
    res.json({ schedules: rows });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'list failed' });
  }
}

router.post('/request', (req, res) => {
  const internalKey = String(req.headers['x-agentflow-brain-internal'] ?? '').trim();
  const expected = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  if (expected && internalKey === expected) {
    const walletAddress = String(req.body?.walletAddress ?? '').trim();
    if (!walletAddress || !looksLikeAddress(walletAddress)) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }
    let payee: `0x${string}`;
    try {
      payee = getAddress(walletAddress);
    } catch {
      res.status(400).json({ error: 'Invalid walletAddress' });
      return;
    }
    void handleCreatePaymentRequest(req, res, payee);
    return;
  }
  authMiddleware(req, res, () => {
    let payee: `0x${string}`;
    try {
      payee = getAddress(normalizeWallet(req));
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void handleCreatePaymentRequest(req, res, payee);
  });
});

router.post('/schedule', (req, res) => {
  const internalKey = String(req.headers['x-agentflow-brain-internal'] ?? '').trim();
  const expected = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  if (expected && internalKey === expected) {
    const walletAddress = String(req.body?.walletAddress ?? '').trim();
    if (!walletAddress || !looksLikeAddress(walletAddress)) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }
    let payer: `0x${string}`;
    try {
      payer = getAddress(walletAddress);
    } catch {
      res.status(400).json({ error: 'Invalid walletAddress' });
      return;
    }
    void handleSchedulePost(req, res, payer);
    return;
  }
  authMiddleware(req, res, () => {
    let payer: `0x${string}`;
    try {
      const authedWallet = getAddress(normalizeWallet(req));
      const requestedWallet = String(req.query.walletAddress ?? '').trim();
      if (requestedWallet) {
        const normalizedRequested = getAddress(requestedWallet);
        if (normalizedRequested.toLowerCase() !== authedWallet.toLowerCase()) {
          res.status(403).json({ error: 'Wallet does not match authenticated session' });
          return;
        }
        payer = normalizedRequested;
      } else {
        payer = authedWallet;
      }
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void handleSchedulePost(req, res, payer);
  });
});

router.get('/schedule', (req, res) => {
  const internalKey = String(req.headers['x-agentflow-brain-internal'] ?? '').trim();
  const expected = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  if (expected && internalKey === expected) {
    const walletAddress = String(req.query.walletAddress ?? '').trim();
    if (!walletAddress || !looksLikeAddress(walletAddress)) {
      res.status(400).json({ error: 'walletAddress query param is required' });
      return;
    }
    let payer: `0x${string}`;
    try {
      payer = getAddress(walletAddress);
    } catch {
      res.status(400).json({ error: 'Invalid walletAddress' });
      return;
    }
    void handleScheduleList(req, res, payer);
    return;
  }
  authMiddleware(req, res, () => {
    let payer: `0x${string}`;
    try {
      payer = getAddress(normalizeWallet(req));
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void handleScheduleList(req, res, payer);
  });
});

router.delete('/schedule/:id', (req, res) => {
  const internalKey = String(req.headers['x-agentflow-brain-internal'] ?? '').trim();
  const expected = process.env.AGENTFLOW_BRAIN_INTERNAL_KEY?.trim();
  const id = String(req.params.id ?? '').trim();
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  if (expected && internalKey === expected) {
    const walletAddress = String(req.query.walletAddress ?? '').trim();
    if (!walletAddress || !looksLikeAddress(walletAddress)) {
      res.status(400).json({ error: 'walletAddress query param is required' });
      return;
    }
    let payer: `0x${string}`;
    try {
      payer = getAddress(walletAddress);
    } catch {
      res.status(400).json({ error: 'Invalid walletAddress' });
      return;
    }
    void (async () => {
      try {
        await cancelScheduledPayment(id, payer);
        res.json({ ok: true });
      } catch (e: any) {
        const message = e?.message ?? 'cancel failed';
        const status = /not found|already cancelled/i.test(message) ? 404 : 500;
        res.status(status).json({ error: message });
      }
    })();
    return;
  }
  authMiddleware(req, res, () => {
    let payer: `0x${string}`;
    try {
      const authedWallet = getAddress(normalizeWallet(req));
      const requestedWallet = String(req.query.walletAddress ?? '').trim();
      if (requestedWallet) {
        const normalizedRequested = getAddress(requestedWallet);
        if (normalizedRequested.toLowerCase() !== authedWallet.toLowerCase()) {
          res.status(403).json({ error: 'Wallet does not match authenticated session' });
          return;
        }
        payer = normalizedRequested;
      } else {
        payer = authedWallet;
      }
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      try {
        await cancelScheduledPayment(id, payer);
        res.json({ ok: true });
      } catch (e: any) {
        const message = e?.message ?? 'cancel failed';
        const status = /not found|already cancelled/i.test(message) ? 404 : 500;
        res.status(status).json({ error: message });
      }
    })();
  });
});

router.get('/requests', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));

    // Resolve the caller's DCW so we can match both EOA and DCW identities.
    // Background: `.arc` names resolve to the owner's DCW, so payment_requests
    // created against `.arc` names have `from_wallet = DCW`. Without this OR
    // filter, incoming requests to `.arc` recipients are invisible in the
    // Requests tab (same class of bug that broke the Invoices tab).
    let dcwAddr: string | null = null;
    try {
      const ua = await getOrCreateUserAgentWallet(authAddr);
      if (ua?.address?.trim()) {
        dcwAddr = getAddress(ua.address as `0x${string}`);
      }
    } catch {
      dcwAddr = null;
    }

    const fromFilter = dcwAddr
      ? `from_wallet.eq.${authAddr},from_wallet.eq.${dcwAddr}`
      : `from_wallet.eq.${authAddr}`;
    const { data: incoming, error: inErr } = await adminDb
      .from('payment_requests')
      .select('*, invoices!payment_requests_invoice_id_fkey(id, invoice_number, vendor_name, line_items, created_at)')
      .or(fromFilter)
      .eq('status', 'pending')
      .is('invoice_id', null)
      .order('created_at', { ascending: false });

    if (inErr) {
      return res.status(500).json({ error: inErr.message });
    }

    // Outgoing: requests this user initiated. `initiated_by` is stored as the
    // caller's EOA in handleCreatePaymentRequest; OR with DCW as a defensive
    // match in case a tool ever stamps the DCW instead.
    const initFilter = dcwAddr
      ? `initiated_by.eq.${authAddr},initiated_by.eq.${dcwAddr}`
      : `initiated_by.eq.${authAddr}`;
    const { data: outgoing, error: outErr } = await adminDb
      .from('payment_requests')
      .select('*, invoices!payment_requests_invoice_id_fkey(id, invoice_number, vendor_name, line_items, created_at)')
      .or(initFilter)
      .order('created_at', { ascending: false });

    if (outErr) {
      return res.status(500).json({ error: outErr.message });
    }

    const authLower = authAddr.toLowerCase();
    const dcwLower = dcwAddr?.toLowerCase() ?? null;
    // Self-initiated rows shouldn't show in "incoming" (avoid seeing your own
    // request in your own inbox if from/to ever collapse to the same identity).
    const inc = (incoming ?? []).filter((row: any) => {
      const init = String(row?.initiated_by ?? '').toLowerCase();
      return init !== authLower && (dcwLower ? init !== dcwLower : true);
    });
    const out = (outgoing ?? []).filter((row: any) => {
      const init = String(row?.initiated_by ?? '').toLowerCase();
      return init === authLower || (dcwLower ? init === dcwLower : false);
    });

    return res.json({ incoming: inc, outgoing: out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'requests failed' });
  }
});

router.post('/approve/:requestId', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const requestId = String(req.params.requestId ?? '').trim();

    const { data: row, error } = await adminDb
      .from('payment_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (String(row.status) !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    // Payer identity check: from_wallet may be stored as EOA or DCW (invoice
    // flows resolve .arc names to DCW). Allow either to authorize approval.
    const fromLower = String(row.from_wallet).toLowerCase();
    const authLower = authAddr.toLowerCase();
    if (fromLower !== authLower) {
      // Only resolve DCW if the direct EOA check fails — avoids a Circle/DB
      // hit on the common path.
      let payerDcw: string | null = null;
      try {
        const ua = await getOrCreateUserAgentWallet(authAddr);
        if (ua?.address?.trim()) {
          payerDcw = getAddress(ua.address as `0x${string}`).toLowerCase();
        }
      } catch {
        payerDcw = null;
      }
      if (fromLower !== payerDcw) {
        return res.status(403).json({ error: 'Only the payer can approve this request' });
      }
    }

    const amount = Number(row.amount ?? 0);
    const remark = row.remark ? String(row.remark).slice(0, 500) : null;
    const toAddr = getAddress(String(row.to_wallet));

    const { txHash } = await executeUsdcTransfer({
      payerEoa: authAddr,
      toAddress: toAddr,
      amountUsdc: amount,
      remark,
      actionType: 'agentpay_request',
    });

    await incrementTxCount('agentpay');

    const paidAt = new Date().toISOString();
    const { error: upErr } = await adminDb
      .from('payment_requests')
      .update({
        status: 'paid',
        paid_at: paidAt,
        arc_tx_id: txHash,
      })
      .eq('id', requestId);

    if (upErr) {
      return res.status(500).json({ error: upErr.message });
    }

    // If this request was linked to an invoice, mark the invoice paid too.
    try {
      await markInvoicePaidFromRequest(requestId, txHash);
    } catch (e) {
      console.warn('[pay/approve] markInvoicePaidFromRequest failed (non-fatal):', e);
    }

    return res.json({ txHash, explorerLink: explorerLinkTx(txHash) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'approve failed' });
  }
});

router.post('/decline/:requestId', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const requestId = String(req.params.requestId ?? '').trim();

    const { data: row, error } = await adminDb
      .from('payment_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (String(row.status) !== 'pending') {
      return res.status(400).json({ error: 'Request is not pending' });
    }

    const fromLower = String(row.from_wallet).toLowerCase();
    const authLower = authAddr.toLowerCase();
    if (fromLower !== authLower) {
      let payerDcw: string | null = null;
      try {
        const ua = await getOrCreateUserAgentWallet(authAddr);
        if (ua?.address?.trim()) {
          payerDcw = getAddress(ua.address as `0x${string}`).toLowerCase();
        }
      } catch {
        payerDcw = null;
      }
      if (fromLower !== payerDcw) {
        return res.status(403).json({ error: 'Only the payer can decline this request' });
      }
    }

    const { error: upErr } = await adminDb
      .from('payment_requests')
      .update({ status: 'declined' })
      .eq('id', requestId);

    if (upErr) {
      return res.status(500).json({ error: upErr.message });
    }

    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'decline failed' });
  }
});

router.get('/history', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    let ua: Awaited<ReturnType<typeof getOrCreateUserAgentWallet>> | null = null;
    try {
      ua = await getOrCreateUserAgentWallet(authAddr);
    } catch {
      return res.json({ transactions: [] });
    }
    if (!ua?.address?.trim() || !ua?.wallet_id?.trim()) {
      return res.json({ transactions: [] });
    }
    const dcwAddr = getAddress(ua.address as `0x${string}`);

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(200, Math.floor(rawLimit))
        : 50;
    const type = String(req.query.type ?? '').toLowerCase();

    let q = adminDb
      .from('transactions')
      .select('*')
      .eq('agent_slug', AGENTPAY_SLUG)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (type === 'in') {
      q = q.or(`to_wallet.eq.${dcwAddr},to_wallet.eq.${authAddr}`);
    } else if (type === 'out') {
      q = q.or(`from_wallet.eq.${dcwAddr},from_wallet.eq.${authAddr}`);
    } else {
      q = q.or(agentPayWalletOrFilter(dcwAddr, authAddr));
    }

    const { data, error } = await q;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const txs = (data ?? []).map((row: any) => ({
      ...row,
      direction: agentPayDirection(row, dcwAddr, authAddr),
      explorerLink: row.arc_tx_id ? explorerLinkTx(String(row.arc_tx_id)) : null,
    }));

    return res.json({ transactions: txs });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'history failed' });
  }
});

router.post('/export', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    let ua: Awaited<ReturnType<typeof getOrCreateUserAgentWallet>> | null = null;
    try {
      ua = await getOrCreateUserAgentWallet(authAddr);
    } catch {
      await sendAgentPayEmptyExportWorkbook(res);
      return;
    }
    if (!ua?.address?.trim() || !ua?.wallet_id?.trim()) {
      await sendAgentPayEmptyExportWorkbook(res);
      return;
    }
    const dcwAddr = getAddress(ua.address as `0x${string}`);

    const { data, error } = await adminDb
      .from('transactions')
      .select('*')
      .eq('agent_slug', AGENTPAY_SLUG)
      .or(agentPayWalletOrFilter(dcwAddr, authAddr))
      .order('created_at', { ascending: false })
      .limit(5000);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const rows = (data ?? []).map((row: any) => {
      const dir = agentPayDirection(row, dcwAddr, authAddr);
      const txh = row.arc_tx_id ? String(row.arc_tx_id) : '';
      const created = row.created_at ? new Date(row.created_at) : null;
      return {
        Date: created && !Number.isNaN(created.getTime()) ? created.toLocaleString() : '',
        Type: dir === 'in' ? 'Incoming' : 'Outgoing',
        'Amount (USDC)': row.amount ?? '',
        From: row.from_wallet ?? '',
        To: row.to_wallet ?? '',
        Remark: row.remark ?? '',
        Status: row.status ?? '',
        TxHash: txh,
        Explorer: txh ? explorerLinkTx(txh) : '',
      };
    });

    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Date: '', Note: 'No rows' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
    const buf = workbookToXlsxBuffer(XLSX, wb);
    sendBinaryXlsxResponse(res, buf);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'export failed' });
  }
});

export async function fetchPayHistoryForBrain(walletAddress: string, limit: number) {
  const eoaAddr = getAddress(walletAddress);
  let ua: Awaited<ReturnType<typeof getOrCreateUserAgentWallet>> | null = null;
  try {
    ua = await getOrCreateUserAgentWallet(eoaAddr);
  } catch {
    return [];
  }
  if (!ua?.address?.trim() || !ua?.wallet_id?.trim()) {
    return [];
  }
  const dcwAddr = getAddress(ua.address as `0x${string}`);
  const { data, error } = await adminDb
    .from('transactions')
    .select('*')
    .eq('agent_slug', AGENTPAY_SLUG)
    .or(agentPayWalletOrFilter(dcwAddr, eoaAddr))
    .order('created_at', { ascending: false })
    .limit(Math.min(200, limit));

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row: any) => ({
    ...row,
    direction: agentPayDirection(row, dcwAddr, eoaAddr),
    explorerLink: row.arc_tx_id ? explorerLinkTx(String(row.arc_tx_id)) : null,
  }));
}

router.get('/invoices', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));

    // Resolve this user's DCW so we can match both EOA and DCW identities.
    // - invoices.business_wallet is stored as the creator's EOA (authAddr)
    // - payment_requests.from_wallet for invoice-linked rows is stored as the
    //   payer's DCW (because .arc resolves to DCW). See lib/invoice-agentpay.ts.
    let dcwAddr: string | null = null;
    try {
      const ua = await getOrCreateUserAgentWallet(authAddr);
      if (ua?.address?.trim()) {
        dcwAddr = getAddress(ua.address as `0x${string}`);
      }
    } catch {
      dcwAddr = null;
    }

    // Sent invoices: match both EOA and DCW on business_wallet (defensive).
    const sentFilter = dcwAddr
      ? `business_wallet.eq.${authAddr},business_wallet.eq.${dcwAddr}`
      : `business_wallet.eq.${authAddr}`;
    const { data: sent, error } = await adminDb
      .from('invoices')
      .select('id, invoice_number, vendor_name, vendor_handle, amount, currency, status, arc_tx_id, line_items, created_at, settled_at')
      .or(sentFilter)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Received: invoice-linked payment requests where this user is the payer.
    // Match both EOA and DCW since .arc resolution writes DCW into from_wallet.
    const receivedFilter = dcwAddr
      ? `from_wallet.eq.${authAddr},from_wallet.eq.${dcwAddr}`
      : `from_wallet.eq.${authAddr}`;
    const { data: received, error: recErr } = await adminDb
      .from('payment_requests')
      .select(`id, amount, status, created_at, invoice_id, from_wallet, to_wallet,
        invoices!payment_requests_invoice_id_fkey (
          id, invoice_number, vendor_name, vendor_handle,
          amount, currency, line_items, status, arc_tx_id,
          created_at, settled_at, business_wallet
        )`)
      .or(receivedFilter)
      .not('invoice_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (recErr) return res.status(500).json({ error: recErr.message });

    return res.json({ sent: sent ?? [], received: received ?? [] });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'invoices fetch failed' });
  }
});

/** Accept 0x… or *.arc; return checksummed recipient for storage. */
async function normalizeContactAddressForStorage(raw: string): Promise<`0x${string}`> {
  const t = raw.trim();
  if (!t) {
    throw new Error('address is required');
  }
  if (looksLikeAddress(t)) {
    return getAddress(t);
  }
  if (t.toLowerCase().includes('.arc')) {
    const resolved = await resolveRegistryName(t);
    if (!resolved) {
      throw new Error(`${t} is not registered on AgentPay`);
    }
    return getAddress(resolved as `0x${string}`);
  }
  throw new Error('Address must be a valid 0x address or .arc name');
}

// --- Contacts (address book) — must stay before `/:handle` profile route ---

router.get('/contacts/resolve/:name', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const raw = decodeURIComponent(String(req.params.name ?? '').trim());
    if (!raw) {
      return res.status(400).json({ error: 'name is required' });
    }
    const { data, error } = await adminDb
      .from('contacts')
      .select('name, address, label')
      .eq('wallet_address', authAddr)
      .ilike('name', raw.toLowerCase())
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!data?.address) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    return res.json({
      name: String(data.name ?? raw),
      address: String(data.address),
      label: data.label != null ? String(data.label) : null,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'resolve failed' });
  }
});

router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const { data, error } = await adminDb
      .from('contacts')
      .select('*')
      .eq('wallet_address', authAddr)
      .order('name', { ascending: true });
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ contacts: data ?? [] });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'contacts list failed' });
  }
});

router.post('/contacts', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const nameRaw = String(req.body?.name ?? '').trim().toLowerCase();
    const addressRaw = String(req.body?.address ?? '').trim();
    const label = req.body?.label != null ? String(req.body.label).trim().slice(0, 120) : null;
    const notes = req.body?.notes != null ? String(req.body.notes).trim().slice(0, 2000) : null;

    if (!nameRaw || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(nameRaw)) {
      return res.status(400).json({ error: 'Invalid name (use letters, numbers, underscore, hyphen)' });
    }
    let resolved: `0x${string}`;
    try {
      resolved = await normalizeContactAddressForStorage(addressRaw);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message ?? 'Invalid address' });
    }

    const row = {
      wallet_address: authAddr,
      name: nameRaw.toLowerCase(),
      address: resolved,
      ...(label ? { label } : {}),
      ...(notes ? { notes } : {}),
    };

    const { data, error } = await adminDb.from('contacts').insert(row).select().single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return res.status(409).json({ error: 'A contact with this name already exists' });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'contact create failed' });
  }
});

router.put('/contacts/:id', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const id = String(req.params.id ?? '').trim();
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const { data: existing, error: exErr } = await adminDb
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('wallet_address', authAddr)
      .maybeSingle();
    if (exErr) {
      return res.status(500).json({ error: exErr.message });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const patch: Record<string, unknown> = {};
    if (req.body?.name != null) {
      const n = String(req.body.name).trim().toLowerCase();
      if (!n || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(n)) {
        return res.status(400).json({ error: 'Invalid name' });
      }
      patch.name = n.toLowerCase();
    }
    if (req.body?.address != null) {
      const a = String(req.body.address).trim();
      try {
        patch.address = await normalizeContactAddressForStorage(a);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message ?? 'Invalid address' });
      }
    }
    if (req.body?.label !== undefined) {
      patch.label = req.body.label === null || req.body.label === '' ? null : String(req.body.label).trim().slice(0, 120);
    }
    if (req.body?.notes !== undefined) {
      patch.notes = req.body.notes === null || req.body.notes === '' ? null : String(req.body.notes).trim().slice(0, 2000);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await adminDb
      .from('contacts')
      .update(patch)
      .eq('id', id)
      .eq('wallet_address', authAddr)
      .select()
      .single();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'contact update failed' });
  }
});

router.delete('/contacts/:id', authMiddleware, async (req, res) => {
  try {
    const authAddr = getAddress(normalizeWallet(req));
    const id = String(req.params.id ?? '').trim();
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    const { data: deletedRows, error } = await adminDb
      .from('contacts')
      .delete()
      .eq('id', id)
      .eq('wallet_address', authAddr)
      .select('id');
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!deletedRows?.length) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'contact delete failed' });
  }
});

// --- External transfer ledger recording ----------------------------------
// Background: the public /pay/[handle] page lets non-AgentFlow users pay with
// their own wallet via a direct USDC ERC-20 transfer on Arc. That bypasses
// our DCW-driven /api/pay/send path, so nothing gets written to the
// `transactions` ledger and the recipient's AgentPay history stays empty.
//
// This endpoint verifies the on-chain transfer and inserts a row into the
// same ledger (`agent_slug='agentpay'`, `action_type='agentpay_external'`)
// so the recipient (and payer, if they're an AgentFlow user) see it in
// history, exports, etc. It is idempotent via the UNIQUE arc_tx_id constraint.
//
// Public — no JWT required. Trust anchor is the on-chain receipt we fetch
// ourselves from Arc Testnet.

const ARC_USDC_ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const arcReadChain = defineChain({
  id: ARC.chainId,
  name: ARC.blockchain,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC.alchemyRpc || ARC.rpc] } },
});

let arcReadClientSingleton: ReturnType<typeof createPublicClient> | null = null;
function getArcReadClient() {
  if (!arcReadClientSingleton) {
    arcReadClientSingleton = createPublicClient({
      chain: arcReadChain,
      transport: http(ARC.alchemyRpc || ARC.rpc),
    });
  }
  return arcReadClientSingleton;
}

router.post('/record-external', async (req, res) => {
  try {
    const txHashRaw = String(req.body?.txHash ?? '').trim();
    const fromRaw = String(req.body?.fromAddress ?? '').trim();
    const toRaw = String(req.body?.toAddress ?? '').trim();
    const amountRaw = Number(req.body?.amountUsdc);
    const remarkRaw = String(req.body?.remark ?? '').trim();
    const remark = remarkRaw ? remarkRaw.slice(0, 500) : null;

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHashRaw)) {
      return res.status(400).json({ error: 'Invalid txHash' });
    }
    if (!fromRaw || !toRaw) {
      return res.status(400).json({ error: 'fromAddress and toAddress are required' });
    }
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
      return res.status(400).json({ error: 'amountUsdc must be a positive number' });
    }

    let fromAddr: `0x${string}`;
    let toAddr: `0x${string}`;
    try {
      fromAddr = getAddress(fromRaw);
      toAddr = getAddress(toRaw);
    } catch {
      return res.status(400).json({ error: 'Invalid address' });
    }

    // Idempotency: if we already recorded this tx, return the existing row.
    {
      const { data: existing } = await adminDb
        .from('transactions')
        .select('id, arc_tx_id, agent_slug')
        .eq('arc_tx_id', txHashRaw)
        .maybeSingle();
      if (existing?.id) {
        return res.json({ ok: true, recorded: false, id: existing.id });
      }
    }

    const txHash = txHashRaw as `0x${string}`;
    const client = getArcReadClient();

    // Fetch and verify the on-chain transfer.
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }).catch(() => null),
      client.getTransactionReceipt({ hash: txHash }).catch(() => null),
    ]);
    if (!tx || !receipt) {
      return res.status(404).json({ error: 'Transaction not found on Arc' });
    }
    if (receipt.status !== 'success') {
      return res.status(400).json({ error: 'Transaction did not succeed on-chain' });
    }

    if (!tx.to || getAddress(tx.to).toLowerCase() !== ARC_USDC.toLowerCase()) {
      return res.status(400).json({ error: 'Transaction target is not the USDC contract' });
    }
    if (getAddress(tx.from).toLowerCase() !== fromAddr.toLowerCase()) {
      return res.status(400).json({ error: 'fromAddress does not match on-chain sender' });
    }

    // Decode the USDC `transfer(to, amount)` calldata and compare.
    let decodedTo: `0x${string}`;
    let decodedAmount: bigint;
    try {
      const decoded = decodeFunctionData({
        abi: ARC_USDC_ERC20_ABI,
        data: tx.input,
      });
      if (decoded.functionName !== 'transfer') {
        return res.status(400).json({ error: 'Transaction is not a USDC transfer' });
      }
      [decodedTo, decodedAmount] = decoded.args as [`0x${string}`, bigint];
    } catch {
      return res.status(400).json({ error: 'Unable to decode transfer calldata' });
    }

    if (getAddress(decodedTo).toLowerCase() !== toAddr.toLowerCase()) {
      return res.status(400).json({ error: 'toAddress does not match on-chain recipient' });
    }
    const expectedAmount = parseUnits(amountRaw.toFixed(6), 6);
    if (decodedAmount !== expectedAmount) {
      return res.status(400).json({ error: 'amountUsdc does not match on-chain amount' });
    }

    // Insert into ledger. Unique (arc_tx_id) guards against races.
    const { data: inserted, error: insErr } = await adminDb
      .from('transactions')
      .insert({
        from_wallet: fromAddr,
        to_wallet: toAddr,
        amount: amountRaw,
        arc_tx_id: txHash,
        agent_slug: AGENTPAY_SLUG,
        action_type: 'agentpay_external',
        status: 'complete',
        remark,
      })
      .select('id')
      .single();

    if (insErr) {
      // Race on unique arc_tx_id — treat as success.
      if (/duplicate|unique/i.test(insErr.message)) {
        return res.json({ ok: true, recorded: false });
      }
      return res.status(500).json({ error: insErr.message });
    }

    return res.json({
      ok: true,
      recorded: true,
      id: inserted?.id,
      explorerLink: explorerLinkTx(txHash),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'record-external failed' });
  }
});

// Public profile endpoint consumed by /pay/[handle] page.
// Must be last so it doesn't shadow any specific route above.
router.get('/:handle', async (req, res) => {
  try {
    const raw = String(req.params.handle ?? '').trim().toLowerCase().replace(/\.arc$/i, '');
    if (!raw) return res.status(404).json({ error: 'Not found' });
    const address = await resolveRegistryName(raw);
    if (!address) return res.status(404).json({ error: 'Not found' });
    return res.json({ handle: `${raw}.arc`, walletAddress: address, business: null });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Profile load failed' });
  }
});

export default router;
