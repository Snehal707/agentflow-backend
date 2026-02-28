"use client";

import { useState, useCallback } from "react";
import { useAccount, useChainId } from "wagmi";
import { Header } from "@/components/Header";
import { Onboarding } from "@/components/Onboarding";
import { AgentPipeline, type AgentStep } from "@/components/AgentPipeline";
import { Receipt } from "@/components/Receipt";
import { Report } from "@/components/Report";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { useStackHealth } from "@/lib/hooks/useStackHealth";
import { ARC_CHAIN_ID } from "@/lib/arcChain";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

const INITIAL_STEPS: AgentStep[] = [
  { key: "research", label: "Research Agent", price: "0.005", status: "idle" },
  { key: "analyst", label: "Analyst Agent", price: "0.003", status: "idle" },
  { key: "writer", label: "Writer Agent", price: "0.008", status: "idle" },
];

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { gatewayBalance, isLowBalance, refetch } = useGatewayBalance(address);
  const { stackHealth } = useStackHealth();

  const [task, setTask] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>(INITIAL_STEPS);
  const [receipt, setReceipt] = useState<{
    researchTx?: string;
    analystTx?: string;
    writerTx?: string;
    total?: string;
  } | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const isOnArc = chainId === ARC_CHAIN_ID;
  const canRun =
    isConnected &&
    isOnArc &&
    !isLowBalance &&
    gatewayBalance >= 0.016 &&
    !isRunning &&
    task.trim().length > 0;

  const disabledReason = !task.trim()
    ? "Enter a research task"
    : !isConnected
      ? "Connect wallet"
      : !isOnArc
        ? "Switch to Arc Testnet"
        : isLowBalance || gatewayBalance < 0.016
          ? "Low Gateway balance (need ≥0.016 USDC)"
          : isRunning
            ? "Running…"
            : null;

  const runAgentFlow = useCallback(async () => {
    const t = task.trim();
    if (!t) {
      setError("Please enter a research task.");
      return;
    }

    setError(null);
    setReport(null);
    setReceipt(null);
    setSteps(INITIAL_STEPS);
    setIsRunning(true);

    try {
      const res = await fetch(`${BACKEND_URL}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: t, userAddress: address }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Failed to start AgentFlow.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            if (event.type === "step_start") {
              setSteps((prev) =>
                prev.map((s) =>
                  s.key === event.step ? { ...s, status: "running" as const } : s
                )
              );
            } else if (event.type === "step_complete") {
              setSteps((prev) =>
                prev.map((s) =>
                  s.key === event.step
                    ? {
                        ...s,
                        status: "complete" as const,
                        tx: event.tx,
                      }
                    : s
                )
              );
            } else if (event.type === "receipt") {
              setReceipt({
                researchTx: event.researchTx,
                analystTx: event.analystTx,
                writerTx: event.writerTx,
                total: event.total,
              });
            } else if (event.type === "report") {
              setReport(event.markdown || "");
            } else if (event.type === "error") {
              setError(event.message || "Unknown error");
            }
          } catch {
            // ignore parse errors
          }
        }
      }
      refetch();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unexpected error running AgentFlow."
      );
    } finally {
      setIsRunning(false);
    }
  }, [task, refetch]);

  const reset = useCallback(() => {
    setError(null);
    setReport(null);
    setReceipt(null);
    setSteps(INITIAL_STEPS);
  }, []);

  return (
    <div className="min-h-screen max-w-6xl mx-auto px-4 py-8">
      <Header />
      <Onboarding />

      {stackHealth && !stackHealth.ok && (
        <div className="mb-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm text-amber-200">
          <strong>Backend not ready.</strong> Run{" "}
          <code className="bg-black/30 px-1 rounded">npm run dev:stack</code>
          {" "}(or start facilitator on 3000 and agents on 3001–3003 separately).
        </div>
      )}

      <section className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-6 mb-6">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
          Prompt
        </div>
        <div className="flex flex-wrap gap-4 items-start">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should the agents research?"
            className="flex-1 min-w-[260px] min-h-[80px] rounded-xl bg-black/40 border border-white/20 px-4 py-3 text-sm text-white placeholder:text-gray-500 resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
            disabled={isRunning}
          />
          <div className="flex gap-2">
            <button
              onClick={runAgentFlow}
              disabled={!canRun}
              title={disabledReason ?? undefined}
              type="button"
              className="px-5 py-3 rounded-full bg-gradient-to-r from-primary to-accent text-white font-semibold text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-opacity"
            >
              <span className="w-4 h-4 rounded-full border-2 border-white/80 flex items-center justify-center">
                <span className="border-l-2 border-t-2 border-white w-1.5 h-1.5 -ml-0.5 -mt-0.5 rotate-[-45deg]" />
              </span>
              Run AgentFlow
            </button>
            {(report || receipt) && (
              <button
                onClick={reset}
                disabled={isRunning}
                className="px-5 py-3 rounded-full border border-white/20 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                Reset
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {["~0.5s finality", "~$0.01/tx", "USDC gas", "EVM compatible"].map(
            (badge) => (
              <span
                key={badge}
                className="text-xs px-2.5 py-1 rounded-full bg-black/40 border border-white/10 text-[var(--muted)]"
              >
                {badge}
              </span>
            )
          )}
        </div>
        {error && (
          <div className="mt-4 p-3 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
      </section>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <AgentPipeline steps={steps} />
        <Receipt data={receipt} isLowBalance={isLowBalance} />
      </div>

      <Report markdown={report} />

      <footer className="mt-12 flex flex-wrap justify-between items-center gap-4 text-sm text-[var(--muted)]">
        <div>
          <strong className="text-white">AgentFlow</strong> · Powered by Arc
          Testnet · Circle x402 · Hermes AI
        </div>
        <div>
          Chain ID {ARC_CHAIN_ID} · RPC https://rpc.testnet.arc.network
        </div>
      </footer>
    </div>
  );
}
