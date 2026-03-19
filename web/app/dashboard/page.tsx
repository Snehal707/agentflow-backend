"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAccount, useChainId } from "wagmi";
import { Onboarding } from "@/components/Onboarding";
import { AgentPipeline, type AgentStep } from "@/components/AgentPipeline";
import { Receipt } from "@/components/Receipt";
import { Report } from "@/components/Report";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import { useStackHealth } from "@/lib/hooks/useStackHealth";
import { ARC_CHAIN_ID } from "@/lib/arcChain";
import { trackEvent } from "@/lib/ga";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

const PRICES = {
  research: "0.005",
  analyst: "0.003",
  writer: "0.008",
} as const;

const MIN_GATEWAY_BALANCE = 0.016;
const TOTAL_PIPELINE_COST = (
  Number(PRICES.research) +
  Number(PRICES.analyst) +
  Number(PRICES.writer)
).toFixed(3);

const INITIAL_STEPS: AgentStep[] = [
  { key: "research", label: "Research Agent", price: PRICES.research, status: "idle" },
  { key: "analyst", label: "Analyst Agent", price: PRICES.analyst, status: "idle" },
  { key: "writer", label: "Writer Agent", price: PRICES.writer, status: "idle" },
];

type StepKey = AgentStep["key"];
type StepFailure = Error & { step?: StepKey };
type PanelTone = "gold" | "cyan" | "indigo" | "emerald";

const SECTION_STYLES: Record<
  PanelTone,
  { border: string; title: string; line: string; bg: string }
> = {
  gold: {
    border: "border-gold/20",
    title: "text-white",
    line: "from-gold/70 via-gold/14 to-transparent",
    bg: "bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.08),transparent_42%),#0b0b0b]",
  },
  cyan: {
    border: "border-gold/16",
    title: "text-white",
    line: "from-gold/60 via-gold/12 to-transparent",
    bg: "bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.05),transparent_38%),#0b0b0b]",
  },
  indigo: {
    border: "border-gold/16",
    title: "text-white",
    line: "from-gold/60 via-gold/12 to-transparent",
    bg: "bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.05),transparent_38%),#0b0b0b]",
  },
  emerald: {
    border: "border-gold/16",
    title: "text-white",
    line: "from-gold/60 via-gold/12 to-transparent",
    bg: "bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.05),transparent_38%),#0b0b0b]",
  },
};

function WorkspaceSection({
  title,
  tone,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  tone: PanelTone;
  className?: string;
  children: ReactNode;
}) {
  const styles = SECTION_STYLES[tone];

  return (
    <section
      className={`relative overflow-hidden rounded-[26px] border p-6 ${styles.border} ${styles.bg} ${className ?? ""}`}
    >
      <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${styles.line}`} />
      <h2 className={`relative text-base font-medium tracking-[0.01em] ${styles.title}`}>
        {title}
      </h2>
      <div className="relative mt-6">{children}</div>
    </section>
  );
}

function StatText({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: "default" | "good" | "warn";
}) {
  const valueClass =
    tone === "good"
      ? "text-white"
      : tone === "warn"
        ? "text-gold/90"
        : "text-white";

  return (
    <div className="min-w-[120px]">
      <span className="text-[10px] uppercase tracking-[0.12em] text-gold/52">
        {label}
      </span>
      <div className={`mt-1 text-lg font-semibold tracking-tight ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
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
  const isWalletReady = mounted && isConnected && isOnArc;
  const canRun =
    isConnected &&
    isOnArc &&
    !isLowBalance &&
    gatewayBalance >= MIN_GATEWAY_BALANCE &&
    !isRunning &&
    task.trim().length > 0;

  const disabledReason = !task.trim()
    ? "Enter a research brief"
    : !isConnected
      ? "Connect wallet"
      : !isOnArc
        ? "Switch to Arc Testnet"
        : isLowBalance || gatewayBalance < MIN_GATEWAY_BALANCE
          ? `Gateway requires ${MIN_GATEWAY_BALANCE.toFixed(3)} USDC`
          : isRunning
            ? "Pipeline active"
            : null;

  const briefHint = !task.trim()
    ? "Brief required"
    : !isConnected
      ? "Connect wallet"
      : !isOnArc
        ? "Switch to Arc"
        : isLowBalance || gatewayBalance < MIN_GATEWAY_BALANCE
          ? "Top up Gateway"
          : isRunning
            ? "Running..."
            : "Ready";

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
      setError("Please enter a research brief.");
      return;
    }
    if (!address) {
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

    trackEvent("pipeline_started", {
      wallet_address: address,
      task_length: trimmedTask.length,
      timestamp: Date.now(),
    });

    try {
      const response = await fetch(`${BACKEND_URL}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: trimmedTask,
          userAddress: address,
        }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(
          text || `Pipeline start failed with status ${response.status}`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let receivedEventCount = 0;
      let sawTerminalEvent = false;
      let activeStep: StepKey | undefined;

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const json = trimmed.slice(5).trim();
        if (!json) return;

        try {
          const event = JSON.parse(json) as
            | { type: "step_start"; step: StepKey; price: string }
            | { type: "step_complete"; step: StepKey; tx?: string; amount?: string }
            | {
                type: "receipt";
                researchTx?: string;
                analystTx?: string;
                writerTx?: string;
                total?: string;
              }
            | { type: "report"; markdown: string }
            | { type: "error"; message: string; step?: StepKey };
          receivedEventCount += 1;

          switch (event.type) {
            case "step_start":
              activeStep = event.step;
              updateStep(event.step, "running");
              break;
            case "step_complete":
              if (activeStep === event.step) {
                activeStep = undefined;
              }
              updateStep(event.step, "complete", event.tx);
              trackEvent(`${event.step}_complete`, {
                wallet_address: address,
                tx: event.tx,
                timestamp: Date.now(),
              });
              break;
            case "receipt":
              setReceipt({
                researchTx: event.researchTx,
                analystTx: event.analystTx,
                writerTx: event.writerTx,
                total: event.total,
              });
              break;
            case "report":
              sawTerminalEvent = true;
              setReport(event.markdown);
              trackEvent("pipeline_complete", {
                wallet_address: address,
                timestamp: Date.now(),
              });
              break;
            case "error":
              sawTerminalEvent = true;
              setError(event.message);
              if (event.step) {
                activeStep = event.step;
                updateStep(event.step, "error");
              }
              break;
          }
        } catch (parseError) {
          console.error("Failed to parse SSE event", parseError);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      }

      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          processLine(line);
        }
      }

      if (!sawTerminalEvent) {
        const failure = new Error(
          receivedEventCount === 0
            ? "Pipeline stream closed before any updates were received. Redeploy the backend and check Railway logs."
            : "Pipeline stopped before completion. Check Railway logs for the failing step.",
        ) as StepFailure;
        failure.step = activeStep;
        throw failure;
      }

      await refetch();
    } catch (err) {
      const failure = err as StepFailure;
      setError(failure.message || "Unexpected error running AgentFlow.");
      if (failure.step) {
        updateStep(failure.step, "error");
      }
    } finally {
      setIsRunning(false);
    }
  }, [address, isOnArc, refetch, task, updateStep]);

  const reset = useCallback(() => {
    setError(null);
    setReport(null);
    setReceipt(null);
    setSteps(INITIAL_STEPS);
  }, []);

  const workspaceState = isRunning
    ? "Processing"
    : report
      ? "Ready"
      : canRun
        ? "Ready"
        : "Standby";

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <main className="min-h-screen bg-[#050505] font-sans text-white selection:bg-gold/20 selection:text-gold">
      <div className="mx-auto max-w-[1680px] px-4 py-16 sm:px-6 lg:px-8 xl:px-10 lg:py-24">
        {stackHealth && !stackHealth.ok && (
          <div className="mb-12 border-l border-red-500/50 pl-4 text-xs tracking-wide text-red-400/80">
            System offline. Ensure unified service is running.
          </div>
        )}

        <header className="mb-12 border-b border-gold/14 pb-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <h1 className="text-[34px] font-semibold tracking-tight text-white sm:text-[42px]">
              Research <span className="text-gold">Pipeline</span>
            </h1>
            <div className="flex flex-wrap gap-8 xl:justify-end">
              <StatText
                label="Status"
                value={workspaceState}
                tone={canRun || isRunning || Boolean(report) ? "good" : "default"}
              />
              <StatText
                label="Run Cost"
                value={`$${TOTAL_PIPELINE_COST}`}
                tone="warn"
              />
              <StatText
                label="Auth"
                value={
                  isWalletReady ? (
                    <>
                      <span>Arc </span>
                      <span className="text-gold">Active</span>
                    </>
                  ) : (
                    <span>Disconnected</span>
                  )
                }
                tone={isWalletReady ? "good" : "warn"}
              />
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(460px,520px)_minmax(0,1fr)] xl:gap-10">
          <div className="flex flex-col gap-8">
            <WorkspaceSection eyebrow="Setup" title="Setup" tone="gold">
              <Onboarding />
            </WorkspaceSection>

            <WorkspaceSection eyebrow="Receipt" title="Charges" tone="gold">
              <Receipt data={receipt} isLowBalance={isLowBalance} />
            </WorkspaceSection>
          </div>

          <div className="flex flex-col gap-8">
            <WorkspaceSection eyebrow="Prompt" title="Research brief" tone="indigo">
              <div className="flex flex-col gap-4">
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="Example: Compare Ethereum, Solana, and Base across developer growth, stablecoin activity, and institutional traction."
                  className="h-32 w-full resize-none rounded-2xl border border-gold/14 bg-[#0d0f13] px-5 py-4 text-base leading-7 text-white outline-none transition-colors placeholder:text-white/32 focus:border-gold/50"
                  disabled={isRunning}
                />

                <div className="flex flex-col gap-4 border-t border-gold/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-white/72">
                    {briefHint}
                  </div>

                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    {(report || receipt) && (
                      <button
                        onClick={reset}
                        disabled={isRunning}
                        className="text-left text-sm text-white/56 transition-colors hover:text-white disabled:opacity-30"
                      >
                        Clear output
                      </button>
                    )}

                    <button
                      onClick={runAgentFlow}
                      disabled={!canRun}
                      title={disabledReason ?? undefined}
                      className={`flex w-full items-center justify-center rounded-xl px-6 py-4 text-[15px] font-bold tracking-tight transition-all sm:w-auto sm:min-w-[220px] ${
                        canRun
                          ? "bg-gold text-black shadow-[0_10px_30px_rgba(212,175,85,0.22)] hover:translate-y-[-1px] hover:shadow-[0_14px_34px_rgba(212,175,85,0.28)]"
                          : "border border-gold/20 bg-transparent text-gold/42"
                      } disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none`}
                    >
                      <span>{isRunning ? "Running pipeline..." : "Run pipeline"}</span>
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-red-400/85">
                    {error}
                  </div>
                )}
              </div>
            </WorkspaceSection>

            <WorkspaceSection eyebrow="Pipeline" title="Pipeline" tone="cyan">
              <AgentPipeline steps={steps} />
            </WorkspaceSection>

            <WorkspaceSection
              eyebrow="Report"
              title="Report"
              tone="emerald"
              className="min-h-[320px]"
            >
              <Report markdown={report} />
            </WorkspaceSection>
          </div>
        </div>
      </div>
    </main>
  );
}
