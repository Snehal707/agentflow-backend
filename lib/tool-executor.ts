import { createPublicClient, formatUnits, getAddress, http, parseAbi } from 'viem';

import { ARC } from './arc-config';
import { generateJWT } from './auth';
import { getOrCreateUserAgentWallet } from './dcw';
import { incrementDailyUsageAmount, readDailyUsageAmount } from './usageCaps';
import { resolveArcTokenSymbol } from './swap-symbols';
import { adminDb, getRedis } from '../db/client';
import {
  simulateSwapExecution,
  type SwapSimulationExecutionPayload,
} from '../agents/swap/subagents/simulation';
import {
  simulateTelegramVault,
  type VaultExecutionPayload,
} from './runners/telegramVault';
import {
  formatBridgePrecheckForChat,
  formatBridgeSimulationForChat,
  inspectBridgeSourceWallet,
  listSupportedBridgeSourcesDetailed,
  simulateBridgeTransfer,
  type SupportedSourceChain,
} from '../agents/bridge/bridgeKit';
import { getBridgeReceiptDetails, parseSseJsonPayload } from './bridgeRunReceipt';
import { formatPortfolioSnapshotRecordsForChat } from './format-portfolio-chat';
import {
  BRIDGE_AGENT_PRICE_LABEL,
  ensureSponsoredBridgeLedger,
  executeSponsoredBridgeViaX402,
  executeUserPaidAgentViaX402,
  SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
  SPONSORED_BRIDGE_USAGE_SCOPE,
  SWAP_AGENT_PRICE_LABEL,
  SWAP_RUN_URL,
  VAULT_AGENT_PRICE_LABEL,
  VAULT_RUN_URL,
  type ExecutionPaymentEntry,
} from './paidAgentX402';

const redis = getRedis();

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const ARC_USDC = resolveArcTokenSymbol('USDC');
const ARC_EURC = resolveArcTokenSymbol('EURC');
const DEFAULT_RESEARCH_ERROR = 'Research could not complete right now.';

type RecentExecutionMeta = {
  entries: Array<
    Omit<ExecutionPaymentEntry, 'mode'> & {
      mode?: ExecutionPaymentEntry['mode'] | 'a2a';
      buyerAgent?: string;
      sellerAgent?: string;
    }
  >;
};

type PendingPayload =
  | {
      tool: 'swap_tokens';
      args: Record<string, any>;
      payload: SwapSimulationExecutionPayload;
    }
  | {
      tool: 'vault_action';
      args: Record<string, any>;
      payload: VaultExecutionPayload;
    }
  | {
      tool: 'bridge_usdc';
      args: Record<string, any>;
      recipientAddress: `0x${string}`;
    };

type LocalPendingEntry = {
  value: PendingPayload;
  expiresAt: number;
};

const localPendingStore = new Map<string, LocalPendingEntry>();
const recentExecutionMetaStore = new Map<string, RecentExecutionMeta>();

function pendingKey(sessionId: string): string {
  return `chat:pending:${sessionId}`;
}

function readLocalPending(sessionId: string): PendingPayload | null {
  const entry = localPendingStore.get(sessionId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    localPendingStore.delete(sessionId);
    return null;
  }
  return entry.value;
}

function writeLocalPending(sessionId: string, value: PendingPayload): void {
  localPendingStore.set(sessionId, {
    value,
    expiresAt: Date.now() + 300_000,
  });
}

function deleteLocalPending(sessionId: string): void {
  localPendingStore.delete(sessionId);
}

function setRecentExecutionMeta(sessionId: string, meta: RecentExecutionMeta): void {
  recentExecutionMetaStore.set(sessionId, meta);
}

export function appendRecentExecutionEntries(
  sessionId: string,
  entries: RecentExecutionMeta['entries'],
): void {
  if (!entries.length) return;
  const existing = recentExecutionMetaStore.get(sessionId);
  recentExecutionMetaStore.set(sessionId, {
    entries: [...(existing?.entries ?? []), ...entries],
  });
}

export function takeRecentExecutionMeta(sessionId: string): RecentExecutionMeta | null {
  const meta = recentExecutionMetaStore.get(sessionId) ?? null;
  recentExecutionMetaStore.delete(sessionId);
  return meta;
}

function normalizeAddress(address: string): `0x${string}` {
  return getAddress(address) as `0x${string}`;
}

function shortTx(txHash?: string | null): string {
  if (!txHash) return '';
  return txHash.length <= 14 ? txHash : `${txHash.slice(0, 8)}...${txHash.slice(-4)}`;
}

function shortAddr(address?: string | null): string {
  if (!address) return '';
  return address.length <= 14 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function explorerLinkLine(label: string, href?: string | null): string {
  if (!href) return label;
  return `[${label}](${href})`;
}

function truncateText(value: string, max: number): string {
  const clean = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(digits);
}

function formatSignedMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '$0.00';
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const precision = abs >= 0.01 ? digits : abs >= 0.0001 ? 4 : 6;
  return `${prefix}$${abs.toFixed(precision)}`;
}

function formatSignedPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0.00%';
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const precision = abs >= 0.01 ? digits : abs >= 0.0001 ? 4 : 6;
  return `${prefix}${abs.toFixed(precision)}%`;
}

function formatTokenAmountSmart(rawValue: string | null | undefined): string {
  if (!rawValue) return '0.00';
  const value = Number(formatUnits(BigInt(rawValue), 6));
  if (!Number.isFinite(value)) return '0.00';
  if (value === 0) return '0.000000';
  if (value < 0.001) return value.toFixed(6);
  if (value < 1) return value.toFixed(4);
  return value.toFixed(3);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrapProtectedAgentError(error: unknown, toolName: string): string {
  const raw = errorMessage(error).trim();
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: string;
        executionWalletAddress?: string;
      };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        const clean = parsed.error.replace(/^\[[^\]]+\]\s*/i, '').trim();
        if (
          parsed.executionWalletAddress &&
          /execution wallet has insufficient token balance/i.test(clean)
        ) {
          return `${clean}\n\nAgent wallet: ${parsed.executionWalletAddress}`;
        }
        return clean;
      }
    } catch {
      // fall through to string cleanup
    }
  }

  if (/Payment retry failed with status \d+:/i.test(raw)) {
    const trimmed = raw.replace(/^Error:\s*/i, '');
    const afterColon = trimmed.replace(/^Payment retry failed with status \d+:\s*/i, '').trim();
    if (afterColon) {
      return afterColon;
    }
  }

  return `Error executing ${toolName}: ${raw}`;
}

export async function loadPendingAction(sessionId: string): Promise<PendingPayload | null> {
  try {
    const raw = await redis.get(pendingKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as PendingPayload;
      writeLocalPending(sessionId, parsed);
      return parsed;
    }
  } catch (error) {
    console.warn('[tool-executor] Redis load failed:', errorMessage(error));
  }
  return readLocalPending(sessionId);
}

async function storePending(sessionId: string, value: PendingPayload): Promise<void> {
  writeLocalPending(sessionId, value);
  try {
    await redis.set(pendingKey(sessionId), JSON.stringify(value), 'EX', 300);
  } catch (error) {
    console.warn('[tool-executor] Redis store failed:', errorMessage(error));
  }
}

export async function clearPendingAction(sessionId: string): Promise<void> {
  deleteLocalPending(sessionId);
  try {
    await redis.del(pendingKey(sessionId));
  } catch (error) {
    console.warn('[tool-executor] Redis clear failed:', errorMessage(error));
  }
}

async function readTokenBalance(
  tokenAddress: `0x${string}` | null,
  walletAddress: `0x${string}`,
): Promise<bigint | null> {
  if (!tokenAddress) return null;
  const client = createPublicClient({
    transport: http(ARC.alchemyRpc || ARC.rpc),
  });

  try {
    return (await client.readContract({
      address: tokenAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    })) as bigint;
  } catch {
    return null;
  }
}

async function collectSseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let report = '';
  let fallback = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          newlineIndex = buffer.indexOf('\n');
          continue;
        }

        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          if (typeof parsed.delta === 'string') {
            fallback += parsed.delta;
          }
          if (parsed.type === 'report' && typeof parsed.markdown === 'string') {
            report = parsed.markdown;
          }
          if (parsed.type === 'error' && typeof parsed.message === 'string') {
            return parsed.message;
          }
        } catch {
          fallback += payload;
        }
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }

  return (report || fallback).trim();
}

function summarizePortfolio(snapshot: any): string {
  const parts: string[] = [];

  if (typeof snapshot?.currentValueUsd === 'number') {
    parts.push(`Value: $${formatMoney(snapshot.currentValueUsd)}`);
  }
  if (typeof snapshot?.pnlUsd === 'number') {
    parts.push(`PnL: $${formatMoney(snapshot.pnlUsd)}`);
  }

  if (Array.isArray(snapshot?.holdings) && snapshot.holdings.length > 0) {
    const top = snapshot.holdings
      .slice(0, 3)
      .map((holding: any) => {
        const symbol = typeof holding?.symbol === 'string' ? holding.symbol : 'Asset';
        const amount = typeof holding?.amountFormatted === 'string'
          ? holding.amountFormatted
          : typeof holding?.amount === 'number'
            ? String(holding.amount)
            : null;
        return amount ? `${symbol} ${amount}` : symbol;
      })
      .filter(Boolean)
      .join(', ');

    if (top) {
      parts.push(`Top: ${top}`);
    }
  }

  if (typeof snapshot?.report === 'string' && snapshot.report.trim()) {
    parts.push(snapshot.report.trim());
  }

  return truncateText(parts.join(' | '), 600);
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  walletCtx: {
    walletAddress: string;
    executionWalletId?: string;
    executionWalletAddress?: string;
    executionTarget?: 'EOA' | 'DCW';
  },
  sessionId: string,
): Promise<string> {
  console.log('[tool-executor] called:', toolName, JSON.stringify(args));

  try {
    switch (toolName) {
      case 'get_balance': {
        const address =
          walletCtx.executionTarget === 'DCW' && walletCtx.executionWalletAddress?.trim()
            ? walletCtx.executionWalletAddress.trim()
            : walletCtx.walletAddress.trim();
        if (!address) {
          const result = 'No wallet connected.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        const walletAddress = normalizeAddress(address);
        const client = createPublicClient({
          transport: http(ARC.alchemyRpc || ARC.rpc),
        });
        const vaultAddress = ARC.vaultContract?.trim()
          ? normalizeAddress(ARC.vaultContract)
          : null;
        const balances = { usdc: '0.00', eurc: '0.00', vault: '0.00' };

        try {
          console.log('[tool-executor] reading USDC balance for:', address);
          if (ARC_USDC) {
            const usdcRaw = (await client.readContract({
              address: ARC_USDC,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            })) as bigint;
            balances.usdc = formatMoney(Number(formatUnits(usdcRaw, 6)));
          }
        } catch (e) {
          console.warn('[tool-executor] USDC read failed:', e);
        }

        try {
          console.log('[tool-executor] reading EURC balance for:', address);
          if (ARC_EURC) {
            const eurcRaw = (await client.readContract({
              address: ARC_EURC,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            })) as bigint;
            balances.eurc = formatMoney(Number(formatUnits(eurcRaw, 6)));
          }
        } catch (e) {
          console.warn('[tool-executor] EURC read failed:', e);
        }

        try {
          console.log('[tool-executor] reading vault balance for:', address);
          if (vaultAddress) {
            const vaultRaw = (await client.readContract({
              address: vaultAddress,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            })) as bigint;
            balances.vault = formatMoney(Number(formatUnits(vaultRaw, 6)));
          }
        } catch (e) {
          console.warn('[tool-executor] vault read failed:', e);
        }

        const result = `USDC: ${balances.usdc} | EURC: ${balances.eurc} | Vault: ${balances.vault} afvUSDC`;
        console.log('[tool-executor] result:', result);
        return result;
      }

      case 'swap_tokens': {
        const { amount, tokenIn, tokenOut, confirmed } = args;
        const userWalletAddress = walletCtx.walletAddress.trim();
        if (!userWalletAddress) {
          const result = 'No wallet connected.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        if (walletCtx.executionTarget === 'EOA') {
          if (confirmed) {
            await clearPendingAction(sessionId);
          }
          const result =
            "You selected EOA mode, which means you execute manually from your own wallet.\n\nDCW mode is the agent-execution mode, where AgentFlow executes for you in chat.\n\nThis automated in-chat swap flow currently runs only in DCW mode. If you want AgentFlow to execute it for you here, switch execution mode to DCW. If you want to stay in EOA mode, execute the swap manually from your own wallet.";
          console.log('[tool-executor] result:', result);
          return result;
        }

        if (!confirmed) {
          const execAddress = walletCtx.executionWalletAddress?.trim();
          if (!execAddress) {
            const result =
              'Your execution wallet is not set up yet.\nFund it at agentflow.one/portfolio to start swapping.';
            console.log('[tool-executor] result:', result);
            return result;
          }

          try {
            if (ARC_USDC) {
              const client = createPublicClient({
                transport: http(ARC.alchemyRpc || ARC.rpc),
              });
              const execBalRaw = (await client.readContract({
                address: ARC_USDC,
                abi: ERC20_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [normalizeAddress(execAddress)],
              })) as bigint;
              const execBal = Number(formatUnits(execBalRaw, 6));

              if (execBal < Number(amount)) {
                const result = `Your execution wallet only has ${execBal.toFixed(2)} USDC.\nYou need ${amount} USDC to execute this swap.\n\nFund your execution wallet at agentflow.one/portfolio first.`;
                console.log('[tool-executor] result:', result);
                return result;
              }
            }
          } catch (e) {
            console.warn('[tool-executor] exec balance check failed:', e);
          }

          const tokenInAddress = resolveArcTokenSymbol(String(tokenIn));
          const tokenOutAddress = resolveArcTokenSymbol(String(tokenOut));
          if (!tokenInAddress || !tokenOutAddress) {
            const result = 'Unsupported swap pair. Use USDC or EURC.';
            console.log('[tool-executor] result:', result);
            return result;
          }

          const simulation = await simulateSwapExecution({
            walletAddress: userWalletAddress,
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            amount: Number(amount),
            fromSym: String(tokenIn),
            toSym: String(tokenOut),
          });
          console.log('[tool-executor] raw swap sim:', JSON.stringify(simulation));

          if (!simulation.ok || !simulation.payload) {
            const result = truncateText(
              simulation.blockReason || simulation.summaryLines.join(' | ') || 'Swap simulation failed.',
              300,
            );
            console.log('[tool-executor] result:', result);
            return result;
          }

          await storePending(sessionId, {
            tool: 'swap_tokens',
            args,
            payload: simulation.payload,
          });

          const amountOut = formatTokenAmountSmart(simulation.payload.quoteAmountOutRaw);
          const fee = formatTokenAmountSmart(simulation.payload.quoteFeeRaw);
          const impact =
            simulation.payload.priceImpactPct === null
              ? 'n/a'
              : `${simulation.payload.priceImpactPct.toFixed(2)}%`;

          const result = truncateText(
            `Swap ${amount} ${tokenIn} -> ${amountOut} ${tokenOut}\nFee: ${fee}\nImpact: ${impact}\nReply YES to execute or NO to cancel.`,
            400,
          );
          console.log('[tool-executor] result:', result);
          return result;
        }

        const pending = await loadPendingAction(sessionId);
        if (!pending || pending.tool !== 'swap_tokens') {
          const result = 'No pending swap found. Ask me to simulate it first.';
          console.log('[tool-executor] result:', result);
          return result;
        }

        const paidResult = await executeUserPaidAgentViaX402<{
          success?: boolean;
          error?: string;
          txHash?: string;
          receipt?: {
            explorerLink?: string;
            quoteOutRaw?: string;
          };
        }>({
          agent: 'swap',
          price: SWAP_AGENT_PRICE_LABEL,
          userWalletAddress: normalizeAddress(userWalletAddress),
          requestId: `chat_swap_${sessionId}_${Date.now()}`,
          url: SWAP_RUN_URL,
          body: {
            tokenPair: {
              tokenIn: pending.payload.tokenIn,
              tokenOut: pending.payload.tokenOut,
            },
            amount: pending.payload.amount,
            slippage: pending.payload.requestedSlippage,
          },
        });
        await clearPendingAction(sessionId);
        if (!paidResult.data?.success || !paidResult.data?.txHash) {
          const failure =
            typeof paidResult.data?.error === 'string' && paidResult.data.error.trim()
              ? paidResult.data.error.trim()
              : 'Swap execution failed.';
          console.log('[tool-executor] result:', failure);
          return failure;
        }
        setRecentExecutionMeta(sessionId, {
          entries: [paidResult.paymentEntry],
        });

        const finalResult = truncateText(
          `Executed swap: ${pending.payload.amount} ${pending.payload.fromSym} -> ${formatTokenAmountSmart(
            paidResult.data.receipt?.quoteOutRaw ?? pending.payload.quoteAmountOutRaw,
          )} ${pending.payload.toSym}\n\n${explorerLinkLine(
            `Tx ${shortTx(paidResult.data.txHash)}`,
            paidResult.data.receipt?.explorerLink || '',
          )}`,
          300,
        );
        console.log('[tool-executor] result:', finalResult);
        return finalResult;
      }

      case 'vault_action': {
        const { action, amount, confirmed } = args;
        const userWalletAddress = walletCtx.walletAddress.trim();
        if (!userWalletAddress) {
          const result = 'No wallet connected.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        if (String(action) === 'check_apy') {
          const paidResult = await executeUserPaidAgentViaX402<{
            success?: boolean;
            error?: string;
            apy?: number;
            action?: string;
          }>({
            agent: 'vault',
            price: VAULT_AGENT_PRICE_LABEL,
            userWalletAddress: normalizeAddress(userWalletAddress),
            requestId: `chat_vault_apy_${sessionId}_${Date.now()}`,
            url: VAULT_RUN_URL,
            body: {
              action: 'check_apy',
            },
          });

          if (!paidResult.data?.success) {
            const failure =
              typeof paidResult.data?.error === 'string' && paidResult.data.error.trim()
                ? paidResult.data.error.trim()
                : 'Vault APY lookup failed.';
            console.log('[tool-executor] result:', failure);
            return failure;
          }

          setRecentExecutionMeta(sessionId, {
            entries: [paidResult.paymentEntry],
          });

          const apy =
            typeof paidResult.data.apy === 'number' && Number.isFinite(paidResult.data.apy)
              ? `${paidResult.data.apy.toFixed(2)}%`
              : 'Unavailable';
          const result = `AgentFlow Vault APY: ${apy}`;
          console.log('[tool-executor] result:', result);
          return result;
        }
        if (walletCtx.executionTarget === 'EOA') {
          if (confirmed) {
            await clearPendingAction(sessionId);
          }
          const result =
            "You selected EOA mode, which means you execute manually from your own wallet.\n\nDCW mode is the agent-execution mode, where AgentFlow executes for you in chat.\n\nThis automated in-chat vault flow currently runs only in DCW mode. If you want AgentFlow to execute it for you here, switch execution mode to DCW. If you want to stay in EOA mode, execute the vault action manually from your own wallet.";
          console.log('[tool-executor] result:', result);
          return result;
        }

        if (!confirmed) {
          const simulation = await simulateTelegramVault({
            walletAddress: userWalletAddress,
            action: String(action) as 'deposit' | 'withdraw',
            amount: Number(amount),
          });

          if (!simulation.ok || !simulation.payload) {
            const result = truncateText(
              simulation.blockReason || simulation.summaryLines.join(' | ') || 'Vault simulation failed.',
              300,
            );
            console.log('[tool-executor] result:', result);
            return result;
          }

          await storePending(sessionId, {
            tool: 'vault_action',
            args,
            payload: simulation.payload,
          });

          const compact = simulation.summaryLines
            .filter((line) => !/reply yes or no/i.test(line))
            .join('\n');

          const result = truncateText(`${compact}\nReply YES to execute or NO to cancel.`, 400);
          console.log('[tool-executor] result:', result);
          return result;
        }

        const pending = await loadPendingAction(sessionId);
        if (!pending || pending.tool !== 'vault_action') {
          const result = 'No pending vault action found. Ask me to simulate it first.';
          console.log('[tool-executor] result:', result);
          return result;
        }

        const paidResult = await executeUserPaidAgentViaX402<{
          success?: boolean;
          error?: string;
          txHash?: string;
          explorerLink?: string | null;
          action?: string;
        }>({
          agent: 'vault',
          price: VAULT_AGENT_PRICE_LABEL,
          userWalletAddress: normalizeAddress(userWalletAddress),
          requestId: `chat_vault_${sessionId}_${Date.now()}`,
          url: VAULT_RUN_URL,
          body: {
            action: pending.payload.action,
            amount: pending.payload.amount,
          },
        });
        await clearPendingAction(sessionId);
        if (!paidResult.data?.success || !paidResult.data?.txHash) {
          const failure =
            typeof paidResult.data?.error === 'string' && paidResult.data.error.trim()
              ? paidResult.data.error.trim()
              : 'Vault execution failed.';
          console.log('[tool-executor] result:', failure);
          return failure;
        }
        setRecentExecutionMeta(sessionId, {
          entries: [paidResult.paymentEntry],
        });

        const pendingAction = pending.payload.action;
        const finalResult = truncateText(
          `Executed ${pendingAction === 'deposit' ? 'deposit' : 'withdraw'}: ${pending.payload.amount} USDC\n\n${explorerLinkLine(
            `Tx ${shortTx(paidResult.data.txHash ?? '')}`,
            paidResult.data.explorerLink || '',
          )}`,
          300,
        );
        console.log('[tool-executor] result:', finalResult);
        return finalResult;
      }

      case 'bridge_usdc': {
        const { amount, sourceChain, confirmed } = args;
        if (walletCtx.executionTarget === 'EOA') {
          if (confirmed) {
            await clearPendingAction(sessionId);
          }
          const result =
            "You selected EOA mode, which means you execute manually from your own wallet.\n\nDCW mode is the agent-execution mode, where AgentFlow executes for you in chat.\n\nThis automated in-chat bridge flow currently runs only in DCW mode, so I won't fake an EOA bridge. If you want AgentFlow to execute it for you here, switch execution mode to DCW. If you want to stay in EOA mode, bridge manually from your own wallet.";
          console.log('[tool-executor] result:', result);
          return result;
        }
        const executionAddress = (
          walletCtx.executionTarget === 'DCW' && walletCtx.executionWalletAddress?.trim()
            ? walletCtx.executionWalletAddress.trim()
            : walletCtx.walletAddress
        ).trim();
        if (!executionAddress) {
          const result = 'No execution wallet available.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        const recipientAddress = normalizeAddress(executionAddress);
        const normalizedSourceChain =
          typeof sourceChain === 'string' ? sourceChain.trim().toLowerCase() : '';
        const supportedSourceLabels = listSupportedBridgeSourcesDetailed()
          .map((source) => source.label)
          .join(', ');
        const bridgeClarification =
          `Supported bridge source chains right now: ${supportedSourceLabels}. Tell me the source chain and amount when you want a live bridge estimate. If you want me to check gas and USDC on the source wallet first, I can do that too.`;
        if (
          !normalizedSourceChain ||
          (normalizedSourceChain !== 'ethereum-sepolia' &&
            normalizedSourceChain !== 'base-sepolia')
        ) {
          const result =
            !normalizedSourceChain
              ? bridgeClarification
              : `AgentFlow currently supports ${supportedSourceLabels} as bridge source chains. Tell me which one you want to use.`;
          console.log('[tool-executor] result:', result);
          return result;
        }
        const validatedSourceChain = normalizedSourceChain as SupportedSourceChain;

        if (!confirmed) {
          const requestedAmount = Number(String(amount ?? 0));
          const sponsoredUsage = await readDailyUsageAmount({
            scope: SPONSORED_BRIDGE_USAGE_SCOPE,
            walletAddress: walletCtx.walletAddress,
            limit: SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
          });
          if (
            Number.isFinite(requestedAmount) &&
            requestedAmount > 0 &&
            requestedAmount > sponsoredUsage.remaining
          ) {
            const result = truncateText(
              `AgentFlow sponsors up to ${formatMoney(
                SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
              )} USDC of bridging per user per day. You have ${formatMoney(
                sponsoredUsage.remaining,
              )} USDC remaining today.`,
              300,
            );
            console.log('[tool-executor] result:', result);
            return result;
          }

          const simulation = await simulateBridgeTransfer({
            sourceChain: validatedSourceChain,
            recipientAddress,
            amount: String(amount),
          });

          if (!simulation.ok) {
            const result = truncateText(
              simulation.reason || 'Bridge estimate failed.',
              300,
            );
            console.log('[tool-executor] result:', result);
            return result;
          }

          await storePending(sessionId, {
            tool: 'bridge_usdc',
            args: {
              ...args,
              sourceChain: validatedSourceChain,
            },
            recipientAddress,
          });

          const result = truncateText(
            `${formatBridgeSimulationForChat(simulation, String(amount))}\n\nSponsored bridge allowance remaining today: ${formatMoney(
              sponsoredUsage.remaining,
            )} USDC`,
            600,
          );
          console.log('[tool-executor] result:', result);
          return result;
        }

        const pending = await loadPendingAction(sessionId);
        if (!pending || pending.tool !== 'bridge_usdc') {
          const result = 'No pending bridge found. Ask me to simulate it first.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        const pendingSourceChain = String(pending.args.sourceChain || '').trim().toLowerCase();
        if (
          pendingSourceChain !== 'ethereum-sepolia' &&
          pendingSourceChain !== 'base-sepolia'
        ) {
          await clearPendingAction(sessionId);
          const result =
            'The pending bridge is missing a valid source chain. Ask me to simulate the bridge again and specify Ethereum Sepolia or Base Sepolia.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        const pendingAmount = Number(String(pending.args.amount ?? 0));
        const sponsoredUsage = await readDailyUsageAmount({
          scope: SPONSORED_BRIDGE_USAGE_SCOPE,
          walletAddress: walletCtx.walletAddress,
          limit: SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
        });
        if (
          !Number.isFinite(pendingAmount) ||
          pendingAmount <= 0 ||
          pendingAmount > sponsoredUsage.remaining
        ) {
          await clearPendingAction(sessionId);
          const result = `AgentFlow sponsors up to ${formatMoney(
            SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
          )} USDC of bridging per user per day. You have ${formatMoney(
            sponsoredUsage.remaining,
          )} USDC remaining today. Ask me to simulate a smaller bridge amount.`;
          console.log('[tool-executor] result:', result);
          return result;
        }

        const transfer = await executeSponsoredBridgeViaX402({
          userWalletAddress: normalizeAddress(walletCtx.walletAddress),
          sourceChain: pendingSourceChain as SupportedSourceChain,
          amount: String(pending.args.amount),
        });
        await incrementDailyUsageAmount({
          scope: SPONSORED_BRIDGE_USAGE_SCOPE,
          walletAddress: walletCtx.walletAddress,
          amount: pendingAmount,
          limit: SPONSORED_BRIDGE_DAILY_LIMIT_USDC,
        });
        await clearPendingAction(sessionId);
        await ensureSponsoredBridgeLedger({
          settlement: transfer.transaction,
          transactionRef: transfer.transactionRef,
          recipientAddress: pending.recipientAddress,
        });
        setRecentExecutionMeta(sessionId, {
          entries: [
            {
              requestId: transfer.requestId,
              agent: 'bridge',
              price: BRIDGE_AGENT_PRICE_LABEL,
              payer: transfer.transaction?.payer || 'agentflow_treasury',
              mode: 'sponsored',
              sponsored: true,
              transactionRef: transfer.transactionRef ?? null,
              settlementTxHash: transfer.transaction?.txHash ?? null,
            },
          ],
        });

        const transferData =
          typeof transfer.data === 'string'
            ? (() => {
                const parsed = parseSseJsonPayload(transfer.data);
                if (parsed.done) return parsed.done;
                if (parsed.error) return { success: false, error: parsed.error };
                return {};
              })()
            : transfer.data && typeof transfer.data === 'object'
              ? (transfer.data as Record<string, unknown>)
              : {};
        if (!transferData.success) {
          const result = truncateText(
            typeof transferData.error === 'string'
              ? transferData.error
              : 'Bridge failed.',
            300,
          );
          console.log('[tool-executor] result:', result);
          return result;
        }

        const receipt = getBridgeReceiptDetails(
          transferData.result && typeof transferData.result === 'object'
            ? (transferData.result as Record<string, unknown>)
            : transferData,
        );
        const receiptLine = receipt.explorerUrl
          ? explorerLinkLine(
              `Tx ${shortTx(receipt.txHash) || 'view transaction'}`,
              receipt.explorerUrl,
            )
          : receipt.txHash
            ? `Tx ${shortTx(receipt.txHash)}`
            : 'Bridge submitted. Explorer link unavailable until the transaction is indexed.';
        const finalResult = truncateText(
          `Bridged ${pending.args.amount} USDC to Arc\nSponsored by AgentFlow treasury via x402 — no user Gateway debit required.\n\n${receiptLine}`,
          300,
        );
        console.log('[tool-executor] result:', finalResult);
        return finalResult;
      }

      case 'bridge_precheck': {
        const supportedSources = listSupportedBridgeSourcesDetailed();
        const supportedSourceLabels = supportedSources.map((source) => source.label).join(', ');
        const normalizedSourceChain =
          typeof args.sourceChain === 'string' ? args.sourceChain.trim().toLowerCase() : '';

        if (
          normalizedSourceChain &&
          normalizedSourceChain !== 'ethereum-sepolia' &&
          normalizedSourceChain !== 'base-sepolia'
        ) {
          const result =
            `Supported bridge source chains right now: ${supportedSourceLabels}. ` +
            'I can check gas and USDC only on those source chains.';
          console.log('[tool-executor] result:', result);
          return result;
        }

        const sourceWalletAddress = walletCtx.walletAddress.trim();
        if (!sourceWalletAddress) {
          const result =
            `Supported bridge source chains right now: ${supportedSourceLabels}. ` +
            'Connect a wallet if you want me to read gas and USDC on the source address.';
          console.log('[tool-executor] result:', result);
          return result;
        }

        const report = await inspectBridgeSourceWallet({
          walletAddress: sourceWalletAddress,
          sourceChain: normalizedSourceChain
            ? (normalizedSourceChain as SupportedSourceChain)
            : undefined,
          amount: typeof args.amount === 'string' || typeof args.amount === 'number'
            ? String(args.amount)
            : undefined,
        });

        const result = truncateText(formatBridgePrecheckForChat(report), 1400);
        console.log('[tool-executor] result:', result);
        return result;
      }

      case 'get_portfolio': {
        const address =
          walletCtx.executionTarget === 'DCW' && walletCtx.executionWalletAddress?.trim()
            ? walletCtx.executionWalletAddress.trim()
            : walletCtx.walletAddress.trim();
        if (!address) {
          const result = 'No wallet connected.';
          console.log('[tool-executor] result:', result);
          return result;
        }
        const walletAddress = normalizeAddress(address);
        const gatewayDepositors =
          walletCtx.executionTarget === 'DCW' &&
          walletCtx.walletAddress?.trim() &&
          walletCtx.executionWalletAddress?.trim()
            ? [
                normalizeAddress(walletCtx.walletAddress.trim()),
                normalizeAddress(walletCtx.executionWalletAddress.trim()),
              ]
            : [walletAddress];
        const snapshotUrl = new URL('http://localhost:4000/api/portfolio/snapshot');
        snapshotUrl.searchParams.set('walletAddress', walletAddress);
        snapshotUrl.searchParams.set('gatewayDepositors', gatewayDepositors.join(','));
        const portfolioRes = await fetch(
          snapshotUrl.toString(),
        );
        console.log('[tool-executor] portfolio response status:', portfolioRes.status);
        const rawBody = await portfolioRes.text();
        console.log('[tool-executor] portfolio raw response:', rawBody.slice(0, 500));

        let portfolioData: Record<string, unknown> = {};
        try {
          portfolioData = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          portfolioData = {};
        }

        if (!portfolioRes.ok) {
          const result = truncateText(
            (typeof portfolioData.error === 'string' && portfolioData.error) ||
              rawBody ||
              'Could not fetch portfolio right now.',
            300,
          );
          console.log('[tool-executor] result:', result);
          return result;
        }

        const holdings = Array.isArray(portfolioData.holdings)
          ? (portfolioData.holdings as Array<Record<string, unknown>>)
          : [];
        const positions = Array.isArray(portfolioData.positions)
          ? (portfolioData.positions as Array<Record<string, unknown>>)
          : [];
        const recentTransactions = Array.isArray(portfolioData.recentTransactions)
          ? (portfolioData.recentTransactions as Array<Record<string, unknown>>)
          : [];
        const pnl =
          portfolioData.pnl && typeof portfolioData.pnl === 'object'
            ? (portfolioData.pnl as Record<string, unknown>)
            : portfolioData.pnlSummary && typeof portfolioData.pnlSummary === 'object'
              ? (portfolioData.pnlSummary as Record<string, unknown>)
              : null;
        const result = formatPortfolioSnapshotRecordsForChat(
          {
            holdings,
            positions,
            recentTransactions,
            pnl,
          },
          { maxLength: 1600 },
        );
        console.log('[tool-executor] result:', result);
        return result;
      }

      case 'research': {
        const { query, mode } = args;
        let enrichedQuery = String(query);
        if (
          /\barc\b/i.test(enrichedQuery) &&
          !/token|price|market cap|coin/i.test(enrichedQuery)
        ) {
          enrichedQuery = `${enrichedQuery} Arc Network blockchain Circle L1 stablecoin`;
        }
        const response = await fetch('http://localhost:4000/run', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            task: enrichedQuery,
            userAddress: walletCtx.walletAddress,
            reasoningMode: mode === 'deep' ? 'deep' : 'fast',
            deep: mode === 'deep',
            deepResearch: mode === 'deep',
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          const result = truncateText(errorText || DEFAULT_RESEARCH_ERROR, 300);
          console.log('[tool-executor] result:', result);
          return result;
        }

        const report = await collectSseText(response);
        const result = truncateText(report || DEFAULT_RESEARCH_ERROR, 800);
        console.log('[tool-executor] result:', result);
        return result;
      }

      default: {
        const result = `Unknown tool: ${toolName}`;
        console.log('[tool-executor] result:', result);
        return result;
      }
    }
  } catch (err) {
    console.error('[tool-executor] ERROR:', toolName, err);
    return unwrapProtectedAgentError(err, toolName);
  }
}
