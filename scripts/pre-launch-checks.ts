import dotenv from 'dotenv';
import { getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

dotenv.config();

const FETCH_TIMEOUT_MS = 5000;

const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');
const FACILITATOR_URL = (process.env.FACILITATOR_URL || 'http://localhost:3000').replace(/\/$/, '');
const RESEARCH_AGENT_URL = process.env.RESEARCH_AGENT_URL || 'http://localhost:3001/run';
const ANALYST_AGENT_URL = process.env.ANALYST_AGENT_URL || 'http://localhost:3002/run';
const WRITER_AGENT_URL = process.env.WRITER_AGENT_URL || 'http://localhost:3003/run';

type CheckResult = { pass: boolean; reason?: string; details?: Record<string, unknown> };

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function check1SellerAddressVsPrivateKey(): CheckResult {
  const sellerRaw = process.env.SELLER_ADDRESS?.trim();
  const privateKeyRaw = process.env.PRIVATE_KEY?.trim();
  if (!sellerRaw) {
    return { pass: false, reason: 'SELLER_ADDRESS is not set' };
  }
  if (!privateKeyRaw) {
    return { pass: false, reason: 'PRIVATE_KEY is not set' };
  }
  if (!isAddress(sellerRaw)) {
    return { pass: false, reason: 'SELLER_ADDRESS is not a valid address' };
  }
  const pk = privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const derived = getAddress(account.address);
  const seller = getAddress(sellerRaw);
  if (derived !== seller) {
    return {
      pass: false,
      reason: `Mismatch: derived ${derived}, SELLER_ADDRESS ${seller}`,
    };
  }
  return { pass: true };
}

async function check2Health(): Promise<CheckResult> {
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/health`);
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    if (res.ok && body.status === 'ok') return { pass: true };
    return {
      pass: false,
      reason: res.ok ? `Unexpected body: ${JSON.stringify(body)}` : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      pass: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function check3HealthStack(): Promise<CheckResult & { stack?: Record<string, boolean> }> {
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/health/stack`);
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      facilitator?: boolean;
      research?: boolean;
      analyst?: boolean;
      writer?: boolean;
    };
    const stack = {
      facilitator: !!body.facilitator,
      research: !!body.research,
      analyst: !!body.analyst,
      writer: !!body.writer,
    };
    const ok = res.ok && body.ok === true && stack.facilitator && stack.research && stack.analyst && stack.writer;
    return {
      pass: ok,
      reason: ok ? undefined : `ok=${body.ok}, stack=${JSON.stringify(stack)}`,
      details: { stack },
    };
  } catch (e) {
    return {
      pass: false,
      reason: e instanceof Error ? e.message : String(e),
      details: {},
    };
  }
}

async function check4GatewayBalance(): Promise<CheckResult & { balance?: string; total?: string; address?: string }> {
  const sellerRaw = process.env.SELLER_ADDRESS?.trim();
  let address = sellerRaw;
  if (!address) {
    const pk = process.env.PRIVATE_KEY?.trim();
    if (pk) {
      const normalized = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
      address = privateKeyToAccount(normalized).address;
    }
  }
  if (!address || !isAddress(address)) {
    return { pass: false, reason: 'No valid SELLER_ADDRESS or PRIVATE_KEY to derive address' };
  }
  address = getAddress(address);
  try {
    const url = `${BACKEND_URL}/gateway-balance?address=${encodeURIComponent(address)}`;
    const res = await fetchWithTimeout(url);
    const body = (await res.json().catch(() => ({}))) as {
      balance?: string;
      total?: string;
      address?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        pass: false,
        reason: body.error || `HTTP ${res.status}`,
      };
    }
    return {
      pass: true,
      reason: undefined,
      details: { address: body.address ?? address, balance: body.balance ?? body.formatted, total: body.total },
    };
  } catch (e) {
    return {
      pass: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkAgent402(name: string, agentUrl: string): Promise<CheckResult> {
  try {
    const res = await fetchWithTimeout(agentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'ping' }),
    });
    const hasPaymentRequired = !!res.headers.get('PAYMENT-REQUIRED');
    if (res.status === 402 && hasPaymentRequired) return { pass: true };
    return {
      pass: false,
      reason: `status=${res.status}, PAYMENT-REQUIRED=${hasPaymentRequired}`,
    };
  } catch (e) {
    return {
      pass: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkFacilitatorRoute(path: string): Promise<CheckResult> {
  try {
    const res = await fetchWithTimeout(`${FACILITATOR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 400 && body.error && String(body.error).toLowerCase().includes('missing')) {
      return { pass: true };
    }
    if (res.status === 404 || res.status >= 500) {
      return { pass: false, reason: `HTTP ${res.status}` };
    }
    return { pass: true };
  } catch (e) {
    return {
      pass: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

function padLabel(label: string, width: number): string {
  return (label + ' ').padEnd(width, '.');
}

async function main() {
  console.log('=== Pre-Launch Checks ===\n');

  const results: Array<{ label: string; result: CheckResult; details?: string }> = [];

  const r1 = check1SellerAddressVsPrivateKey();
  results.push({
    label: '1. SELLER_ADDRESS vs PRIVATE_KEY',
    result: r1,
  });

  const r2 = await check2Health();
  results.push({ label: '2. GET /health', result: r2 });

  const r3 = await check3HealthStack();
  const stackLines =
    r3.details?.stack &&
    Object.entries(r3.details.stack as Record<string, boolean>)
      .map(([k, v]) => `   ${k}: ${v ? 'ok' : 'down'}`)
      .join('\n');
  results.push({
    label: '3. GET /health/stack',
    result: r3,
    details: stackLines,
  });

  const r4 = await check4GatewayBalance();
  const balanceDetails =
    r4.details &&
    [
      r4.details.address && `   address: ${r4.details.address}`,
      (r4.details.balance ?? r4.details.total) && `   balance: ${r4.details.balance ?? r4.details.total} USDC`,
      r4.details.total != null && r4.details.balance !== r4.details.total && `   total: ${r4.details.total} USDC`,
    ]
      .filter(Boolean)
      .join('\n');
  results.push({
    label: '4. GET /gateway-balance',
    result: r4,
    details: balanceDetails,
  });

  const r5 = await checkAgent402('research', RESEARCH_AGENT_URL);
  results.push({ label: '5. Agent 402 (research)', result: r5 });

  const r6 = await checkAgent402('analyst', ANALYST_AGENT_URL);
  results.push({ label: '6. Agent 402 (analyst)', result: r6 });

  const r7 = await checkAgent402('writer', WRITER_AGENT_URL);
  results.push({ label: '7. Agent 402 (writer)', result: r7 });

  const r8 = await checkFacilitatorRoute('/v1/x402/verify');
  results.push({ label: '8. Facilitator /v1/x402/verify', result: r8 });

  const r9 = await checkFacilitatorRoute('/v1/x402/settle');
  results.push({ label: '9. Facilitator /v1/x402/settle', result: r9 });

  const width = 45;
  for (const { label, result, details } of results) {
    const status = result.pass ? 'PASS' : `FAIL${result.reason ? ` (${result.reason})` : ''}`;
    console.log(`${padLabel(label, width)} ${status}`);
    if (details) console.log(details);
  }

  const passCount = results.filter((r) => r.result.pass).length;
  const failCount = results.length - passCount;
  console.log('\n=== Summary ===');
  console.log(`PASS: ${passCount}/${results.length}`);
  console.log(`FAIL: ${failCount}/${results.length}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Pre-launch checks failed:', err);
  process.exit(1);
});
