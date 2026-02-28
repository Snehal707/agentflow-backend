"use client";

type StepKey = "research" | "analyst" | "writer" | null;

interface RobotProps {
  isRunning: boolean;
  currentStep: StepKey;
  error: string | null;
}

export function Robot({ isRunning, currentStep, error }: RobotProps) {
  let coreColor = "bg-white/20";
  let ringColor = "border-white/10";
  let pulseAnim = "animate-pulse";
  let statusText = "System Idle - Awaiting Prompt";

  if (error) {
    coreColor = "bg-[var(--danger)]";
    ringColor = "border-[var(--danger)]/50";
    pulseAnim = "animate-ping-slow";
    statusText = "System Error Detected";
  } else if (isRunning) {
    if (currentStep === "research") {
      coreColor = "bg-accent";
      ringColor = "border-accent/50 border-t-accent";
      pulseAnim = "animate-pulse-fast";
      statusText = "Agent 1: Researching Web...";
    } else if (currentStep === "analyst") {
      coreColor = "bg-primary";
      ringColor = "border-primary/50 border-r-primary";
      pulseAnim = "animate-pulse-fast";
      statusText = "Agent 2: Analyzing Data Matrix...";
    } else if (currentStep === "writer") {
      coreColor = "bg-[var(--success)]";
      ringColor = "border-[var(--success)]/50 border-b-[var(--success)]";
      pulseAnim = "animate-pulse-fast";
      statusText = "Agent 3: Synthesizing Report...";
    } else {
      coreColor = "bg-accent/80";
      ringColor = "border-accent/40";
      statusText = "Processing Transaction...";
    }
  }

  return (
    <div className="flex flex-col items-center justify-center p-6 mb-6 glass-panel rounded-xl neon-border relative overflow-hidden">
      <div
        className={`absolute w-32 h-32 blur-3xl rounded-full opacity-20 transition-colors duration-500 ${coreColor}`}
      />
      <div className="relative w-24 h-24 flex items-center justify-center mb-4">
        <div
          className={`absolute inset-0 rounded-full border-4 ${ringColor} ${isRunning && !error ? "animate-spin-slow" : "opacity-50"} transition-all duration-500`}
        />
        <div className="absolute inset-2 rounded-full border border-white/10" />
        <div
          className={`w-8 h-8 rounded-full shadow-[0_0_15px_rgba(255,255,255,0.5)] ${coreColor} ${pulseAnim} transition-colors duration-500`}
        />
      </div>
      <div className="font-mono text-xs tracking-widest uppercase text-[var(--muted)]">
        Status:{" "}
        <span
          className={
            error
              ? "text-[var(--danger)]"
              : isRunning
                ? "text-white"
                : "text-[var(--muted)]"
          }
        >
          {statusText}
        </span>
      </div>
    </div>
  );
}
