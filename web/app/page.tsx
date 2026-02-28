"use client";

import { useCallback, useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import { Header } from "@/components/Header";
import { Onboarding } from "@/components/Onboarding";
import { AgentPipeline, type AgentStep } from "@/components/AgentPipeline";
import { Receipt } from "@/components/Receipt";
import { Report } from "@/components/Report";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { useStackHealth } from "@/lib/hooks/useStackHealth";
import { ARC_CHAIN_ID } from "@/lib/arcChain";
import { payProtectedResource } from "@/lib/x402BrowserClient";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

const AGENT_ENDPOINTS = {
  research: `${BACKEND_URL}/agent/research/run`,
  analyst: `${BACKEND_URL}/agent/analyst/run`,
  writer: `${BACKEND_URL}/agent/writer/run`,
} as const;

const PRICES = {
  research: "0.005",
  analyst: "0.003",
  writer: "0.008",
} as const;

const INITIAL_STEPS: AgentStep[] = [
  { key: "research", label: "Research Agent", price: PRICES.research, status: "idle" },
  { key: "analyst", label: "Analyst Agent", price: PRICES.analyst, status: "idle" },
  { key: "writer", label: "Writer Agent", price: PRICES.writer, status: "idle" },
];

type StepKey = AgentStep["key"];

type ResearchPayload = { task?: string; result?: string };
type AnalystPayload = { research?: string; result?: string };
type WriterPayload = { research?: string; analysis?: string; result?: string };

interface StepFailure extends Error {
  step?: StepKey;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
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
    Boolean(walletClient) &&
    isOnArc &&
    !isLowBalance &&
    gatewayBalance >= 0.016 &&
    !isRunning &&
    task.trim().length > 0;

  const disabledReason = !task.trim()
    ? "Enter a research task"
    : !isConnected
      ? "Connect wallet"
      : !walletClient
        ? "Wallet not ready"
        : !isOnArc
          ? "Switch to Arc Testnet"
          : isLowBalance || gatewayBalance < 0.016
            ? "Low Gateway balance (need >= 0.016 USDC)"
            : isRunning
              ? "Running..."
              : null;

  const updateStep = useCallback(
    (step: StepKey, status: AgentStep["status"], tx?: string) => {
      setSteps((previous) =>
        previous.map((item) =>
          item.key === step
            ? {
                ...item,
                status,
                tx: tx ?? item.tx,
              }
            : item,
        ),
      );
    },
    [],
  );

  const runAgentFlow = useCallback(async () => {
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      setError("Please enter a research task.");
      return;
    }
    if (!walletClient || !address) {
      setError("Connect MetaMask before running AgentFlow.");
      return;
    }
    if (!isOnArc) {
      setError("Switch to Arc Testnet before running AgentFlow.");
      return;
    }

    setError(null);
    setReport(null);
    setReceipt(null);
    setSteps(INITIAL_STEPS);
    setIsRunning(true);

    const runPaidStep = async <TResponse, TBody extends Record<string, unknown>>(
      step: StepKey,
      endpoint: string,
      body: TBody,
    ): Promise<{ data: TResponse; tx?: string }> => {
      try {
        updateStep(step, "running");
        const result = await payProtectedResource<TResponse, TBody>({
          url: endpoint,
          method: "POST",
          body,
          walletClient,
          payer: address,
          chainId: ARC_CHAIN_ID,
          onAwaitSignature: () => updateStep(step, "awaiting_signature"),
        });
        updateStep(step, "complete", result.transaction);
        return { data: result.data, tx: result.transaction };
      } catch (cause) {
        updateStep(step, "error");
        const message =
          cause instanceof Error ? cause.message : "Unknown payment error";
        const failure = new Error(`${step} step failed: ${message}`) as StepFailure;
        failure.step = step;
        throw failure;
      }
    };

    try {
      const researchStep = await runPaidStep<ResearchPayload, { task: string }>(
        "research",
        AGENT_ENDPOINTS.research,
        { task: trimmedTask },
      );

      const analystStep = await runPaidStep<AnalystPayload, { research: string }>(
        "analyst",
        AGENT_ENDPOINTS.analyst,
        { research: JSON.stringify(researchStep.data) },
      );

      const writerStep = await runPaidStep<
        WriterPayload,
        { research: string; analysis: string }
      >("writer", AGENT_ENDPOINTS.writer, {
        research: JSON.stringify(researchStep.data),
        analysis: JSON.stringify(analystStep.data),
      });

      setReceipt({
        researchTx: researchStep.tx,
        analystTx: analystStep.tx,
        writerTx: writerStep.tx,
        total: (
          Number(PRICES.research) +
          Number(PRICES.analyst) +
          Number(PRICES.writer)
        ).toFixed(3),
      });

      const markdown =
        writerStep.data.result ||
        "Writer agent returned no markdown output.";
      setReport(markdown);
      refetch();
    } catch (err) {
      const failure = err as StepFailure;
      setError(failure.message || "Unexpected error running AgentFlow.");
      if (failure.step) {
        updateStep(failure.step, "error");
      }
    } finally {
      setIsRunning(false);
    }
  }, [address, isOnArc, refetch, task, updateStep, walletClient]);

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
          <strong>Backend not ready.</strong> Ensure Railway is running the
          unified backend (`server.ts`) and exposes `/agent/*/run`.
        </div>
      )}

      <section className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-6 mb-6">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
          Prompt
        </div>
        <div className="flex flex-wrap gap-4 items-start">
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
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
            ),
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
        <div>Chain ID {ARC_CHAIN_ID} · RPC https://rpc.testnet.arc.network</div>
      </footer>
    </div>
  );
}
