"use client";

import { useCallback, useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
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

export default function DashboardPage() {
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
            ? { ...item, status, tx: tx ?? item.tx }
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
    <main className="min-h-screen pt-28 pb-12 px-6 lg:px-12">
      {stackHealth && !stackHealth.ok && (
        <div className="mb-4 p-4 rounded-xl glass border border-danger/30 text-sm font-mono text-danger shadow-[0_0_15px_rgba(231,111,81,0.2)]">
          <strong>[SYSTEM_WARN] Backend offline.</strong> Ensure Railway is
          running the unified backend (server.ts) and exposes /agent/*/run.
        </div>
      )}

      <div className="max-w-7xl mx-auto flex flex-col gap-8">
        {/* Top row: Setup/Finance left, Action/Monitoring right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left: Setup/Finance */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <section className="glass p-6 rounded-2xl">
              <h2 className="text-sm font-mono font-bold text-gold mb-4 uppercase tracking-wider">
                Initialization
              </h2>
              <Onboarding />
            </section>
            <section className="glass p-6 rounded-2xl">
              <h2 className="text-sm font-mono font-bold text-platinum mb-4 uppercase tracking-wider">
                Ledger
              </h2>
              <Receipt data={receipt} isLowBalance={isLowBalance} />
            </section>
          </div>

          {/* Right: Action/Monitoring */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            <section className="glass-gold p-6 rounded-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-gold" />
              <h2 className="text-sm font-mono font-bold text-gold mb-4 uppercase tracking-wider">
                Terminal Input
              </h2>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Enter your research task (e.g., 'Research Ethereum's 2025 roadmap')..."
                className="w-full bg-bg-tertiary border border-white/10 rounded-xl p-4 mb-4 text-sm font-mono focus:border-gold/50 outline-none transition-colors resize-none h-40 text-platinum placeholder:text-platinum-muted"
                disabled={isRunning}
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={runAgentFlow}
                  disabled={!canRun}
                  title={disabledReason ?? undefined}
                  className="w-full sm:flex-1 py-3 bg-gold text-bg font-bold rounded-xl hover:bg-gold-light transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-gold/10"
                >
                  {isRunning ? "RUNNING PIPELINE..." : "RUN AGENT PIPELINE"}
                </button>
                {(report || receipt) && (
                  <button
                    onClick={reset}
                    disabled={isRunning}
                    className="py-3 px-4 border border-white/20 text-sm font-mono rounded-xl hover:bg-white/5 disabled:opacity-50 transition-colors text-platinum"
                  >
                    Reset
                  </button>
                )}
              </div>
              {error && (
                <div className="mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm font-mono">
                  &gt; ERROR: {error}
                </div>
              )}
            </section>
            <section className="glass p-6 rounded-2xl">
              <h2 className="text-sm font-mono font-bold text-platinum mb-4 uppercase tracking-wider">
                Pipeline Status
              </h2>
              <AgentPipeline steps={steps} />
            </section>
          </div>
        </div>

        {/* Bottom row: Output full width */}
        <section className="glass p-6 rounded-2xl min-h-[500px] w-full">
          <Report markdown={report} />
        </section>
      </div>
    </main>
  );
}
