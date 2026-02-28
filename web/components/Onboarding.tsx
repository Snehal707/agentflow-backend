"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { useState } from "react";
import { ARC_CHAIN_ID, CIRCLE_FAUCET_URL } from "@/lib/arcChain";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export function Onboarding() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitchPending } = useSwitchChain();
  const { gatewayBalance, isLowBalance, refetch } = useGatewayBalance(address);
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState<
    "idle" | "pending" | "success" | "error"
  >("idle");
  const [depositError, setDepositError] = useState<string | null>(null);

  const isOnArc = chainId === ARC_CHAIN_ID;
  const step1Done = isConnected;
  const step2Done = isOnArc;
  const step3Done = true;
  const step4Done = !isLowBalance && gatewayBalance >= 0.016;
  const allDone = step1Done && step2Done && step4Done;

  const handleDeposit = async () => {
    setDepositStatus("pending");
    setDepositError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: depositAmount || "1",
          depositor: address || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Deposit failed");
      setDepositStatus("success");
      refetch();
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : "Deposit failed");
      setDepositStatus("error");
    }
  };

  if (allDone) return null;

  return (
    <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5 mb-6">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
        4-Step Onboarding
      </h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          className={`p-4 rounded-lg border ${
            step1Done ? "border-[var(--success)]/50 bg-[var(--success)]/5" : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 1
          </div>
          <div className="text-sm font-medium">
            {step1Done ? "✓ Connect MetaMask" : "Connect MetaMask"}
          </div>
          <p className="text-xs text-[var(--muted)] mt-1">
            Use the Connect button above
          </p>
        </div>

        <div
          className={`p-4 rounded-lg border ${
            step2Done ? "border-[var(--success)]/50 bg-[var(--success)]/5" : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 2
          </div>
          <div className="text-sm font-medium">
            {step2Done ? "✓ Arc Testnet" : "Switch to Arc Testnet"}
          </div>
          {!step2Done && (
            <button
              onClick={() => switchChain?.({ chainId: ARC_CHAIN_ID })}
              disabled={isSwitchPending}
              className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSwitchPending ? "Switching..." : "Switch Network"}
            </button>
          )}
        </div>

        <div className="p-4 rounded-lg border border-white/10">
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 3
          </div>
          <div className="text-sm font-medium">Get testnet USDC</div>
          <a
            href={CIRCLE_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs px-3 py-1.5 rounded-lg bg-accent/20 text-accent hover:bg-accent/30"
          >
            Open Faucet
          </a>
        </div>

        <div
          className={`p-4 rounded-lg border ${
            step4Done ? "border-[var(--success)]/50 bg-[var(--success)]/5" : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 4
          </div>
          <div className="text-sm font-medium">
            {step4Done ? "✓ Deposit to Gateway" : "Deposit to Gateway"}
          </div>
          {!step4Done && (
            <div className="mt-2 flex gap-2 items-center">
              <input
                type="text"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="1"
                className="w-16 px-2 py-1 rounded bg-black/40 border border-white/10 text-sm"
              />
              <button
                onClick={handleDeposit}
                disabled={depositStatus === "pending"}
                className="text-xs px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
              >
                {depositStatus === "pending" ? "..." : "Deposit"}
              </button>
            </div>
          )}
          {depositError && (
            <p className="text-xs text-[var(--danger)] mt-1">{depositError}</p>
          )}
        </div>
      </div>

      {!isOnArc && isConnected && (
        <div className="mt-4 p-3 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30 flex items-center justify-between">
          <span className="text-sm text-[var(--danger)]">
            Wrong network. Switch to Arc Testnet to continue.
          </span>
          <button
            onClick={() => switchChain?.({ chainId: ARC_CHAIN_ID })}
            disabled={isSwitchPending}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90"
          >
            Switch to Arc Testnet
          </button>
        </div>
      )}
    </div>
  );
}
