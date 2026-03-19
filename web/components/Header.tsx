"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { ARC_EXPLORER_URL } from "@/lib/arcChain";

interface HeaderProps {
  showWallet?: boolean;
}

export function Header({ showWallet = true }: HeaderProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const { address } = useAccount();
  const { error, isError, reset } = useConnect();
  const { openConnectModal } = useConnectModal();
  const { formattedBalance, isLowBalance, isLoading } =
    useGatewayBalance(address);

  const handleRetry = () => {
    reset();
    openConnectModal?.();
  };

  const containerWidth = showWallet ? "max-w-[1680px]" : "max-w-7xl";

  return (
    <header className="fixed top-0 z-50 w-full border-b border-white/5 bg-bg/60 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8 xl:px-10">
      <div className={`mx-auto flex items-center justify-between ${containerWidth}`}>
        <Link
          href="/"
          className="group flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-white/10 bg-bg-secondary shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-300 group-hover:-translate-y-0.5 group-hover:border-gold/35 sm:h-12 sm:w-12 sm:rounded-[15px]">
            <span className="absolute inset-[1px] rounded-[13px] bg-[linear-gradient(180deg,rgba(255,255,255,0.015),rgba(255,255,255,0))] sm:rounded-[14px]" />
            <span className="absolute inset-x-2.5 bottom-2.5 h-px bg-gradient-to-r from-gold/85 via-gold/45 to-transparent" />
            <span className="relative font-display text-[1.26rem] font-semibold tracking-[-0.11em] sm:text-[1.35rem]">
              <span className="text-platinum">A</span>
              <span className="text-gold">F</span>
            </span>
          </span>
          <span className="block translate-y-[1px] font-display text-[1.45rem] font-semibold leading-none tracking-[-0.045em] text-platinum sm:text-[1.68rem]">
            Agent<span className="text-gold">Flow</span>
          </span>
        </Link>

        {!showWallet && (
          <div className="flex items-center gap-2 rounded-full border border-white/6 bg-white/[0.02] p-1.5 shadow-[0_24px_60px_-44px_rgba(0,0,0,0.9)]">
            <div className="hidden rounded-full border border-white/8 bg-bg-secondary/90 px-4 py-2.5 sm:flex sm:items-center sm:gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-gold shadow-[0_0_12px_rgba(212,184,128,0.55)]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-platinum-muted">
                Arc Testnet
              </span>
            </div>
            <Link
              href="/#flow"
              className="hidden rounded-full px-4 py-2.5 text-sm font-medium text-platinum-muted transition-all hover:bg-white/[0.04] hover:text-platinum sm:inline-flex"
            >
              How it works
            </Link>
            <Link
              href="/dashboard"
              className="rounded-full bg-gold px-5 py-2.5 text-sm font-bold text-bg shadow-[0_18px_40px_rgba(192,160,96,0.22)] transition-all hover:-translate-y-0.5 hover:bg-gold-light"
            >
              Launch Console
            </Link>
          </div>
        )}

        {showWallet && mounted && (
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-3 px-4 py-2 rounded-full bg-bg-tertiary border border-white/5">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                <span className="text-xs font-mono text-platinum/80">
                  Arc Testnet
                </span>
              </div>
              <div className="h-4 w-px bg-white/10" />
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-platinum/80">
                  Balance:
                </span>
                <span
                  className={`text-sm font-mono font-bold ${
                    isLowBalance ? "text-danger" : "text-gold"
                  }`}
                >
                  {isLoading ? "..." : `${formattedBalance} USDC`}
                </span>
              </div>
              <a
                href={ARC_EXPLORER_URL}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-platinum-muted hover:text-gold transition-colors ml-1"
              >
                Arcscan
              </a>
            </div>

            {isError && error && (
              <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 font-mono">
                <span className="text-xs text-danger flex-1">
                  ERR: {error.message}
                </span>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="px-2 py-1 text-xs font-bold rounded bg-danger/20 hover:bg-danger/40 text-danger transition-colors"
                >
                  RETRY
                </button>
              </div>
            )}

            <ConnectButton.Custom>
              {({
                openConnectModal: openConnect,
                openAccountModal,
                mounted: rkMounted,
                account,
              }) => {
                const ready = rkMounted;
                return (
                  <button
                    onClick={ready && account ? openAccountModal : openConnect}
                    className="px-6 py-2.5 rounded-lg bg-gold text-bg font-bold text-sm hover:bg-gold-light transition-all shadow-lg shadow-gold/20"
                  >
                    {ready && account ? account.displayName : "Connect Wallet"}
                  </button>
                );
              }}
            </ConnectButton.Custom>
          </div>
        )}
      </div>
    </header>
  );
}
