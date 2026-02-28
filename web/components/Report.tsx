"use client";

import ReactMarkdown from "react-markdown";

export function Report({ markdown }: { markdown?: string | null }) {
  if (!markdown) {
    return (
      <div className="rounded-xl border border-white/5 p-8 text-center min-h-[200px] flex flex-col justify-center items-center bg-bg-secondary/40">
        <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mb-4 text-platinum-muted bg-bg-tertiary">
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-platinum-muted mb-2">
          No Report Yet
        </h2>
        <p className="text-sm text-platinum-muted max-w-sm">
          Run the agent pipeline to generate a research report. Enter a task and
          click Run Agent Pipeline.
        </p>
      </div>
    );
  }

  const cleaned = markdown
    .split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n");

  return (
    <div className="rounded-xl border border-white/5 overflow-hidden bg-bg-secondary/40">
      <div className="bg-bg-tertiary border-b border-white/10 p-4 flex justify-between items-center font-mono">
        <h2 className="text-xs font-bold uppercase tracking-wider text-success flex items-center gap-2">
          <span className="w-2 h-2 bg-success rounded-full animate-pulse" />
          Final_Synthesis.md
        </h2>
        <span className="text-[10px] text-platinum-muted">
          ENCRYPTED // VERIFIED
        </span>
      </div>
      <div className="p-6 prose prose-luxury prose-invert prose-sm md:prose-base max-w-none max-h-[600px] overflow-auto">
        <ReactMarkdown
          components={{
            h1: ({ children }) => (
              <h1 className="text-xl font-bold text-platinum mt-6 mb-4 border-b border-white/10 pb-2">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-lg font-semibold text-gold mt-5 mb-3">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-base font-medium text-blue-electric mt-4 mb-2">
                {children}
              </h3>
            ),
            p: ({ children }) => (
              <p className="text-platinum/90 my-3 leading-relaxed">{children}</p>
            ),
            code: ({ children }) => (
              <code className="px-1.5 py-0.5 rounded bg-gold/10 text-gold font-mono text-sm">
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="p-4 rounded-lg bg-bg border border-white/10 overflow-x-auto text-sm my-4 font-mono text-platinum/90">
                {children}
              </pre>
            ),
            ul: ({ children }) => (
              <ul className="list-none my-4 space-y-2 pl-4 border-l-2 border-white/10">
                {children}
              </ul>
            ),
            li: ({ children }) => (
              <li className="relative pl-4 before:content-['>'] before:absolute before:left-0 before:text-gold before:font-mono text-platinum/90">
                {children}
              </li>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-outside text-platinum/90 my-4 space-y-2 ml-4">
                {children}
              </ol>
            ),
            a: ({ children, href }) => (
              <a
                href={href}
                className="text-gold hover:text-gold-light underline underline-offset-4"
              >
                {children}
              </a>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-platinum">{children}</strong>
            ),
          }}
        >
          {cleaned}
        </ReactMarkdown>
      </div>
      <div className="border-t border-white/10 p-4 bg-amber-500/10 border-l-4 border-amber-500/60 rounded-b-xl">
        <p className="text-sm text-amber-200/95 flex items-start gap-2">
          <span aria-hidden>⚠️</span>
          <span>
            AI-generated report. Financial figures may be outdated — verify with{" "}
            <a
              href="https://coinmarketcap.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold hover:text-gold-light underline underline-offset-2"
            >
              CoinMarketCap
            </a>
            ,{" "}
            <a
              href="https://www.coingecko.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold hover:text-gold-light underline underline-offset-2"
            >
              CoinGecko
            </a>
            , or other live sources before making decisions.
          </span>
        </p>
      </div>
    </div>
  );
}
