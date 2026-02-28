"use client";

import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useConnect } from "wagmi";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { ARC_CHAIN_ID, ARC_EXPLORER_URL } from "@/lib/arcChain";

export function Header() {
  const { address, isConnected } = useAccount();
  const { error, isError, reset } = useConnect();
  const { openConnectModal } = useConnectModal();
  const { gatewayBalance, formattedBalance, isLowBalance, isLoading } =
    useGatewayBalance(address);

  const handleRetry = () => {
    reset();
    openConnectModal?.();
  };

  return (
    <header className="flex flex-wrap justify-between items-center gap-4 mb-8">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-primary/40">
          AF
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-wide">AgentFlow</h1>
          <p className="text-sm text-[var(--muted)]">
            Autonomous AI agents. Instant payments. Zero gas.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-full bg-black/40 border border-white/10">
          <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
          <div>
            <div className="text-sm font-medium">Arc Testnet · Chain ID {ARC_CHAIN_ID}</div>
            <a
              href={ARC_EXPLORER_URL}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-accent hover:underline"
            >
              View on Arcscan
            </a>
          </div>
        </div>

        <div className="px-3 py-2 rounded-lg bg-black/40 border border-white/10">
          <div className="text-xs text-[var(--muted)]">Gateway balance</div>
          <div
            className={`text-sm font-medium ${
              isLowBalance ? "text-[var(--danger)]" : "text-[var(--success)]"
            }`}
          >
            {isLoading ? "..." : `${formattedBalance} USDC`}
          </div>
        </div>

        {isError && error && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--danger)]/20 border border-[var(--danger)]/50">
            <span className="text-sm text-[var(--danger)] flex-1">
              {error.message}
            </span>
            <button
              type="button"
              onClick={handleRetry}
              className="px-3 py-1 text-sm font-medium rounded-md bg-[var(--danger)]/30 hover:bg-[var(--danger)]/50 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
        <ConnectButton />
      </div>
    </header>
  );
}
