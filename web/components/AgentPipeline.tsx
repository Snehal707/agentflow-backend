"use client";

import { ARC_EXPLORER_URL } from "@/lib/arcChain";
import {
  formatTransactionReference,
  isOnchainTransactionHash,
} from "@/lib/transactions";

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

const STEPS: Array<
  Omit<AgentStep, "status" | "tx"> & { description: string; stage: string }
> = [
  {
    key: "research",
    label: "Research",
    price: "0.005",
    stage: "01",
    description: "Research and source gathering.",
  },
  {
    key: "analyst",
    label: "Analyst",
    price: "0.003",
    stage: "02",
    description: "Analysis and synthesis.",
  },
  {
    key: "writer",
    label: "Writer",
    price: "0.008",
    stage: "03",
    description: "Final report assembly.",
  },
];

const STATUS_META: Record<
  StepStatus,
  { label: string; textClass: string; indicatorClass: string }
> = {
  idle: { label: "Standby", textClass: "text-gold/38", indicatorClass: "bg-gold/12" },
  running: {
    label: "Active",
    textClass: "text-gold",
    indicatorClass: "bg-gold shadow-[0_0_10px_rgba(255,215,0,0.5)]",
  },
  awaiting_signature: {
    label: "Waiting",
    textClass: "text-gold/58",
    indicatorClass: "bg-gold/24",
  },
  complete: {
    label: "Settled",
    textClass: "text-gold/82",
    indicatorClass: "bg-gold/65",
  },
  error: { label: "Halted", textClass: "text-red-400", indicatorClass: "bg-red-500/50" },
};

export function AgentPipeline({ steps }: { steps: AgentStep[] }) {
  const stepMap = Object.fromEntries(steps.map((step) => [step.key, step]));

  return (
    <div className="flex flex-col gap-8 md:flex-row md:gap-12">
      {STEPS.map(({ key, label, stage }) => {
        const step = stepMap[key] ?? {
          key,
          label,
          status: "idle" as StepStatus,
        };
        const meta = STATUS_META[step.status];

        return (
          <article
            key={key}
            className="flex flex-1 flex-col transition-all duration-500"
          >
            <div
              className={`mb-6 h-[1px] w-full transition-colors duration-500 ${meta.indicatorClass}`}
            />

            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-widest text-gold/42">
                {stage}
              </span>
              <span
                className={`text-[10px] uppercase tracking-[0.2em] transition-colors duration-500 ${meta.textClass}`}
              >
                {meta.label}
              </span>
            </div>

            <h3 className="text-lg font-medium tracking-wide text-gold">
              {label}
            </h3>

            {step.tx &&
              (isOnchainTransactionHash(step.tx) ? (
                <a
                  href={`${ARC_EXPLORER_URL}/tx/${step.tx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-6 font-mono text-[10px] text-gold/60 transition-colors hover:text-gold"
                  title={step.tx}
                >
                  ↗ {formatTransactionReference(step.tx)}
                </a>
              ) : (
                <span
                  className="mt-6 font-mono text-[10px] text-gold/48"
                  title={`Gateway batch settlement reference: ${step.tx}`}
                >
                  Batch {formatTransactionReference(step.tx)}
                </span>
              ))}
          </article>
        );
      })}
    </div>
  );
}
