"use client";

export function Landing({ onStart }: { onStart?: () => void }) {
  return (
    <div className="flex flex-col items-center text-center py-16 mb-8 border-b border-white/5 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent/5 rounded-full blur-[100px] -z-10" />
      <div className="absolute top-0 right-1/4 w-[300px] h-[300px] bg-primary/10 rounded-full blur-[80px] -z-10" />
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-mono uppercase tracking-widest mb-6">
        <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
        V.1.0 Online
      </div>
      <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6 text-transparent bg-clip-text bg-gradient-to-r from-white via-accent to-primary drop-shadow-sm">
        Autonomous Intelligence
      </h1>
      <p className="max-w-2xl text-lg text-[var(--muted)] mb-10 leading-relaxed">
        Deploy a swarm of AI agents to research, analyze, and synthesize data in real-time. Powered by instant micro-transactions on the Arc Testnet. Zero gas fees. Total automation.
      </p>
      <button
        onClick={onStart}
        className="group relative px-8 py-4 rounded-full bg-surface border border-accent/30 text-white font-medium hover:bg-accent/10 hover:border-accent transition-all duration-300 flex items-center gap-3 overflow-hidden"
      >
        <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-accent/0 via-accent/10 to-accent/0 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
        <span className="relative z-10 font-mono">Initialize Swarm</span>
        <svg className="w-4 h-4 relative z-10 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
      </button>
    </div>
  );
}
