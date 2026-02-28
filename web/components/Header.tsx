"use client";

import { useState, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { ARC_CHAIN_ID, ARC_EXPLORER_URL } from "@/lib/arcChain";

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

  return (
    <header className="flex justify-between items-center py-6 px-8 bg-bg/50 backdrop-blur-md border-b border-white/5 fixed top-0 w-full z-50">
      <div className="flex items-center gap-2">
        <div className="w-10 h-10 bg-gradient-to-br from-gold to-gold-dark rounded-lg flex items-center justify-center shadow-lg shadow-gold/20">
          <span className="font-mono font-bold text-bg text-xl">AF</span>
        </div>
        <span className="text-xl font-bold text-platinum tracking-wider">
          AGENT<span className="text-gold">FLOW</span>
        </span>
      </div>

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
    </header>
  );
}
