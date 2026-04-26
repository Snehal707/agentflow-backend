/** Shared markdown for portfolio snapshots in chat (tool, paid agent, A2A). */

export type PortfolioChatSnapshotInput = {
  holdings: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  recentTransactions: Array<Record<string, unknown>>;
  pnl: Record<string, unknown> | null;
};

export type FormatPortfolioChatOptions = {
  maxRecent?: number;
  maxLength?: number;
  /** Default "## Portfolio"; e.g. "## Portfolio after this action" for post-trade A2A */
  title?: string;
};

function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) {
    return '0.00';
  }
  return value.toFixed(digits);
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

export function formatPortfolioSnapshotRecordsForChat(
  data: PortfolioChatSnapshotInput,
  options: FormatPortfolioChatOptions = {},
): string {
  const maxRecent = options.maxRecent ?? 5;
  const maxLength = options.maxLength ?? 1600;
  const title = options.title ?? '## Portfolio';

  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const recentTransactions = Array.isArray(data.recentTransactions) ? data.recentTransactions : [];
  const pnl = data.pnl;

  const fmt = (value: unknown): string => formatMoney(Number(value || 0));
  const fmtUsd = (value: unknown): string => `$${formatMoney(Number(value || 0))}`;
  const holdingLine = (holding: Record<string, unknown>): string => {
    const symbol = String(holding.symbol || holding.name || 'Asset').trim();
    const balance = fmt(holding.balanceFormatted);
    const usdValue = Number(holding.usdValue || 0);
    return usdValue > 0 ? `${balance} ${symbol} (${fmtUsd(usdValue)})` : `${balance} ${symbol}`;
  };
  const positionLine = (position: Record<string, unknown>): string => {
    const name = String(position.name || position.protocol || 'Position').trim();
    const amount = String(position.amountFormatted || '').trim();
    const usdValue = Number(position.usdValue || 0);
    const kind = String(position.kind || '').trim();
    if (kind === 'gateway_position') {
      return amount || (usdValue > 0 ? fmtUsd(usdValue) : 'Gateway reserve');
    }
    if (amount) {
      return `${name}: ${amount}${usdValue > 0 ? ` (${fmtUsd(usdValue)})` : ''}`;
    }
    return usdValue > 0 ? `${name}: ${fmtUsd(usdValue)}` : name;
  };
  const recentTransactionLine = (transaction: Record<string, unknown>): string => {
    let method = String(transaction.method || transaction.summary || 'transaction').trim();
    if (method.includes('(')) {
      method = method.split('(')[0]?.trim() || method;
    }
    const status = String(transaction.status || 'unknown').trim();
    let timestamp = String(transaction.timestamp || '').trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) {
      timestamp = timestamp.slice(0, 19).replace('T', ' ');
    }
    const hash = String(transaction.hash || '').trim();
    const shortHash = hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
    return [timestamp || null, method || 'tx', status ? status : null, shortHash || null]
      .filter(Boolean)
      .join(' · ');
  };
  const tokenBalances = holdings
    .filter((holding) => String(holding.kind || '') !== 'vault_share')
    .filter((holding) => Number(holding.usdValue || 0) > 0 || Number(holding.balanceFormatted || 0) > 0)
    .sort((left, right) => Number(right.usdValue || 0) - Number(left.usdValue || 0))
    .map(holdingLine);
  const vaultBalances = holdings
    .filter((holding) => String(holding.kind || '') === 'vault_share')
    .filter((holding) => Number(holding.usdValue || 0) > 0 || Number(holding.balanceFormatted || 0) > 0)
    .map(holdingLine);
  const lpPositions = positions
    .filter((position) => String(position.kind || '') === 'swap_liquidity')
    .filter((position) => Number(position.usdValue || 0) > 0 || String(position.amountFormatted || '').trim())
    .map(positionLine);
  const gatewayPositionRows = positions.filter(
    (position) => String(position.kind || '') === 'gateway_position',
  );
  const gatewayPositions = positions
    .filter((position) => String(position.kind || '') === 'gateway_position')
    .filter((position) => Number(position.usdValue || 0) > 0 || String(position.amountFormatted || '').trim())
    .map(positionLine);
  const recentActivityLines = recentTransactions
    .slice(0, maxRecent)
    .map(recentTransactionLine)
    .filter(Boolean);
  const otherPositions = positions
    .filter((position) => {
      const kind = String(position.kind || '');
      return kind !== 'swap_liquidity' && kind !== 'gateway_position';
    })
    .filter((position) => Number(position.usdValue || 0) > 0 || String(position.amountFormatted || '').trim())
    .map(positionLine);
  const stableSymbols = new Set(['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'FRAX']);
  const tokenSymbols = holdings
    .filter((holding) => String(holding.kind || '') !== 'vault_share')
    .map((holding) => String(holding.symbol || '').toUpperCase())
    .filter(Boolean);
  const stableOnlyWallet =
    tokenSymbols.length > 0 &&
    tokenSymbols.every((symbol) => stableSymbols.has(symbol)) &&
    lpPositions.length === 0 &&
    otherPositions.length === 0;
  const totalUsdc =
    pnl && typeof pnl.currentValueUsd === 'number'
      ? Number(pnl.currentValueUsd)
      : Number.NaN;
  const totalGatewayUsd = gatewayPositionRows.reduce(
    (sum, position) => sum + Number(position.usdValue || 0),
    0,
  );
  const walletOnlyTotalUsd = Number.isFinite(totalUsdc)
    ? Math.max(0, totalUsdc - totalGatewayUsd)
    : Number.NaN;
  const recentActivityBlock =
    recentActivityLines.length > 0
      ? ['**Recent activity**', '', ...recentActivityLines.map((line) => `- ${line}`)].join('\n')
      : '_Recent activity: none in the Arc explorer snapshot._';

  const result = truncateText(
    [
      title,
      tokenBalances.length > 0
        ? `**Wallet tokens:** ${tokenBalances.join(', ')}`
        : '**Wallet tokens:** none found.',
      vaultBalances.length > 0 ? `**Vault:** ${vaultBalances.join(', ')}` : null,
      lpPositions.length > 0 ? `**Liquidity:** ${lpPositions.join('; ')}` : null,
      gatewayPositions.length > 0
        ? `**Gateway reserve:** ${gatewayPositions.join('; ')}`
        : null,
      otherPositions.length > 0
        ? `**Other positions:** ${otherPositions.join('; ')}`
        : null,
      gatewayPositions.length > 0 && Number.isFinite(walletOnlyTotalUsd)
        ? `**Wallet value:** $${formatMoney(walletOnlyTotalUsd)}`
        : `**Total marked value:** $${formatMoney(totalUsdc)}`,
      gatewayPositions.length > 0 && Number.isFinite(totalUsdc)
        ? `**Combined wallet + Gateway:** $${formatMoney(totalUsdc)}`
        : null,
      recentActivityBlock,
      stableOnlyWallet
        ? '_Small moves here are usually swaps, fees, and transfers — not big market swings._'
        : null,
    ]
      .filter((line) => line !== null && line !== undefined)
      .join('\n\n'),
    maxLength,
  );
  return result;
}

/** Body for chat after a successful paid Portfolio agent run (snapshot + analysis + footer). */
export function formatPaidPortfolioAgentChatBody(
  data: Record<string, unknown>,
  priceLabel: string,
): string {
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const recentTransactions = Array.isArray(data.recentTransactions) ? data.recentTransactions : [];
  const pnl =
    data.pnl && typeof data.pnl === 'object'
      ? (data.pnl as Record<string, unknown>)
      : data.pnlSummary && typeof data.pnlSummary === 'object'
        ? (data.pnlSummary as Record<string, unknown>)
        : null;
  const snapshot = formatPortfolioSnapshotRecordsForChat({
    holdings: holdings as Array<Record<string, unknown>>,
    positions: positions as Array<Record<string, unknown>>,
    recentTransactions: recentTransactions as Array<Record<string, unknown>>,
    pnl,
  });
  const report = typeof data.report === 'string' ? data.report.trim() : '';
  const parts: string[] = [snapshot];
  if (report) {
    parts.push(`## Analysis\n\n${report}`);
  }
  parts.push(`_Paid Portfolio Agent (${priceLabel} via x402)._`);
  return parts.join('\n\n');
}
