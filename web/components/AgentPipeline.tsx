"use client";

import { ARC_EXPLORER_URL } from "@/lib/arcChain";

export type StepStatus =
  | "idle"
  | "running"
  | "awaiting_signature"
  | "complete"
  | "error";

export interface AgentStep {
  key: "research" | "analyst" | "writer";
  label: string;
  price: string;
  status: StepStatus;
  tx?: string;
}

const STEPS: Omit<AgentStep, "status" | "tx">[] = [
  { key: "research", label: "Research Agent", price: "0.005" },
  { key: "analyst", label: "Analyst Agent", price: "0.003" },
  { key: "writer", label: "Writer Agent", price: "0.008" },
];

export function AgentPipeline({ steps }: { steps: AgentStep[] }) {
  const stepMap = Object.fromEntries(steps.map((step) => [step.key, step]));

  return (
    <div className="space-y-4 flex-1 font-mono">
      {STEPS.map(({ key, label, price }) => {
        const step = stepMap[key] ?? {
          key,
          label,
          price,
          status: "idle" as StepStatus,
        };

        return (
          <div
            key={key}
            className={`flex flex-col sm:flex-row items-start sm:items-center gap-4 p-4 rounded-lg border transition-colors duration-300 ${
              step.status === "running" || step.status === "awaiting_signature"
                ? "border-gold/50 bg-gold/5 shadow-[inset_0_0_15px_rgba(192,160,96,0.05)]"
                : step.status === "complete"
                  ? "border-success/20 bg-bg-tertiary/80"
                  : step.status === "error"
                    ? "border-danger/30 bg-bg-tertiary/80"
                    : "border-white/5 bg-bg-tertiary/80"
            }`}
          >
            <div className="flex-1 w-full">
              <div className="text-sm font-bold text-platinum mb-1">
                {step.label}
              </div>
              <div className="text-xs text-platinum-muted">
                Cost: <span className="text-gold">${step.price}</span> USDC
              </div>
            </div>
            <div className="flex flex-col items-start sm:items-end gap-1 w-full sm:w-auto min-w-[200px]">
              {step.status === "idle" && (
                <span className="text-xs text-platinum-muted border border-white/10 px-2 py-1 rounded bg-bg">
                  [ STANDBY ]
                </span>
              )}

              {step.status === "running" && (
                <div className="flex items-center gap-2 text-xs text-gold">
                  <div className="w-3 h-3 border-2 border-gold border-t-transparent rounded-full animate-spin" />
                  EXECUTING...
                </div>
              )}

              {step.status === "awaiting_signature" && (
                <div className="flex items-center gap-2 text-xs text-gold">
                  <div className="w-3 h-3 bg-gold animate-pulse" />
                  AWAITING_SIG
                </div>
              )}

              {step.status === "complete" && (
                <>
                  <span className="text-xs text-success">
                    [ SUCCESS ]
                  </span>
                  {step.tx && (
                    <a
                      href={`${ARC_EXPLORER_URL}/tx/${step.tx}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-platinum-muted hover:text-platinum truncate max-w-[180px] bg-bg px-2 py-1 rounded border border-white/5"
                    >
                      TX: {step.tx.slice(0, 12)}...
                    </a>
                  )}
                </>
              )}

              {step.status === "error" && (
                <span className="text-xs text-danger">
                  [ FAILED ]
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
