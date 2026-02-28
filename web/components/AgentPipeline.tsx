"use client";

export type StepStatus = "idle" | "running" | "complete";

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
  const stepMap = Object.fromEntries(steps.map((s) => [s.key, s]));

  return (
    <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
        Agent Pipeline
      </div>
      <div className="space-y-3">
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
              className="flex items-center gap-3 p-3 rounded-lg bg-black/40 border border-white/5"
            >
              <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center text-xs text-[var(--muted)]">
                {STEPS.findIndex((s) => s.key === key) + 1}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">{step.label}</div>
                <div className="text-xs text-[var(--muted)]">
                  Paying ${step.price} USDC
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 min-w-[140px]">
                {step.status === "idle" && (
                  <span className="text-xs text-[var(--muted)]">
                    Waiting to start
                  </span>
                )}
                {step.status === "running" && (
                  <>
                    <div className="w-4 h-4 rounded-full border-2 border-accent/50 border-t-accent animate-spin" />
                    <span className="text-xs text-[var(--muted)]">
                      Paying via x402...
                    </span>
                  </>
                )}
                {step.status === "complete" && (
                  <>
                    <div className="w-5 h-5 rounded-full border border-[var(--success)] flex items-center justify-center text-[var(--success)] text-xs">
                      ✓
                    </div>
                    <span className="text-xs text-[var(--success)]">
                      Paid ${step.price} USDC
                    </span>
                    {step.tx && (
                      <a
                        href={`https://testnet.arcscan.app/tx/${step.tx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent hover:underline truncate max-w-[120px]"
                      >
                        {step.tx.slice(0, 8)}...
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
