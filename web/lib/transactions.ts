export function isOnchainTransactionHash(
  value?: string | null,
): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

export function formatTransactionReference(value: string): string {
  return `${value.slice(0, 14)}...`;
}
