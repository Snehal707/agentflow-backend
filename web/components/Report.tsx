"use client";

import ReactMarkdown from "react-markdown";

export function Report({ markdown }: { markdown?: string | null }) {
  if (!markdown) {
    return (
      <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
          Final Report
        </h2>
        <p className="text-sm text-[var(--muted)]">
          Run AgentFlow to see the writer agent&apos;s markdown report here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
        Final Report
      </h2>
      <div className="prose prose-invert prose-sm max-h-[400px] overflow-auto">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="text-lg font-bold text-white mt-4 mb-2">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-base font-semibold text-white mt-3 mb-1">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-sm font-medium text-white mt-2 mb-1">
                {children}
              </h3>
            ),
            p: ({ children }) => (
              <p className="text-sm text-[var(--text)] my-2">{children}</p>
            ),
            code: ({ children }) => (
              <code className="px-1.5 py-0.5 rounded bg-black/40 text-accent text-xs">
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="p-3 rounded-lg bg-black/60 overflow-x-auto text-xs my-2">
                {children}
              </pre>
            ),
            ul: ({ children }) => (
              <ul className="list-disc list-inside text-sm my-2 space-y-1">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside text-sm my-2 space-y-1">
                {children}
              </ol>
            ),
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
