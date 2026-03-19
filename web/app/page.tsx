import Link from "next/link";
import { Header } from "@/components/Header";

const proof = ["3 agents", "USDC on Arc", "x402 settlement", "Live receipts"] as const;

const stages = [
  {
    index: "01",
    title: "Connect and fund",
    copy: "Link your wallet, create a Circle wallet, and top up Gateway balance.",
  },
  {
    index: "02",
    title: "Run the pipeline",
    copy: "Research, Analyst, and Writer execute in sequence against one brief.",
  },
  {
    index: "03",
    title: "Track every payment",
    copy: "Each step settles in USDC and lands with a receipt and final report.",
  },
] as const;

const featureCards = [
  {
    title: "Nanopayment rails",
    copy:
      "Each agent step settles through Circle x402 instead of hiding cost behind a vague usage meter.",
  },
  {
    title: "Wallet-backed execution",
    copy:
      "The workflow starts from a connected wallet, funded Gateway balance, and real onchain payment flow.",
  },
  {
    title: "Output with proof",
    copy:
      "Receipts, tx links, Gateway balance, and markdown output live in the same experience.",
  },
] as const;

export default function LandingPage() {
  return (
    <main id="top" className="min-h-screen overflow-x-hidden bg-bg">
      <Header showWallet={false} />

      <section className="relative overflow-hidden border-b border-white/5 pt-32 sm:pt-36">
        <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.16),transparent_32%),radial-gradient(circle_at_82%_18%,rgba(192,160,96,0.08),transparent_18%),linear-gradient(180deg,#070707_0%,#0a0a0a_55%,#0d0d0d_100%)]" />
        <div
          className="absolute inset-0 -z-10 opacity-20"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "96px 96px",
            maskImage:
              "radial-gradient(circle at center, black 34%, transparent 82%)",
          }}
        />

        <div className="mx-auto grid min-h-[calc(100vh-7rem)] max-w-7xl gap-14 px-4 pb-20 sm:px-6 sm:pb-24 lg:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] lg:items-center lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-gold/20 bg-white/[0.03] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-gold/85">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              Arc Testnet • Circle x402
            </div>

            <h1 className="mt-8 max-w-4xl font-display text-[3.9rem] font-medium leading-[0.94] tracking-[-0.055em] text-platinum sm:text-[4.8rem] lg:text-[5.4rem] xl:text-[5.8rem]">
              Three agents.
              <br />
              <span className="text-[0.94em] tracking-[-0.065em] bg-gradient-to-r from-gold-light via-gold to-gold-dark bg-clip-text text-transparent">
                One visible workflow.
              </span>
            </h1>

            <p className="mt-7 max-w-xl text-lg leading-8 text-platinum-muted sm:text-xl">
              Connect a wallet, fund Gateway balance, and run Research -&gt;
              Analyst -&gt; Writer with x402 nanopayments, live receipts, and a
              final report on Arc Testnet.
            </p>

            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-full bg-gold px-7 py-3.5 text-base font-bold text-bg shadow-[0_18px_40px_rgba(192,160,96,0.22)] transition-all hover:-translate-y-0.5 hover:bg-gold-light"
              >
                Launch Console
              </Link>
              <Link
                href="#flow"
                className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-7 py-3.5 text-base font-semibold text-platinum transition-all hover:border-gold/30 hover:text-gold"
              >
                See the flow
              </Link>
            </div>

            <div className="mt-10 flex flex-wrap gap-3">
              {proof.map((item) => (
                <div
                  key={item}
                  className="rounded-full border border-white/8 bg-white/[0.025] px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-platinum-muted"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="absolute left-10 top-10 h-32 w-32 rounded-full bg-gold/10 blur-3xl" />
            <div className="absolute bottom-8 right-0 h-24 w-24 rounded-full bg-gold/10 blur-3xl" />

            <div className="relative overflow-hidden rounded-[30px] border border-gold/18 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-6 shadow-[0_30px_90px_rgba(0,0,0,0.56)] sm:p-7">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold/70">
                    AgentFlow Console
                  </div>
                  <div className="mt-2 max-w-[15ch] font-display text-[1.7rem] font-medium leading-[1.05] tracking-[-0.04em] text-platinum">
                    One brief,
                    <span className="block bg-gradient-to-r from-gold-light via-gold to-gold-dark bg-clip-text text-transparent">
                      three settling agents
                    </span>
                  </div>
                </div>
                <div className="rounded-full border border-gold/15 bg-gold/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-gold">
                  $0.016
                </div>
              </div>

              <div className="mt-6 rounded-[24px] border border-white/8 bg-black/25 p-5">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold/70">
                  Research brief
                </div>
                <p className="mt-3 text-sm leading-6 text-platinum/86">
                  Turn one task into research, analysis, and a final written
                  brief while every settlement stays visible.
                </p>
              </div>

              <div className="mt-5 space-y-3">
                {[
                  { label: "Research", price: "$0.005" },
                  { label: "Analyst", price: "$0.003" },
                  { label: "Writer", price: "$0.008" },
                ].map((step, index) => (
                  <div
                    key={step.label}
                    className="flex items-center justify-between rounded-[22px] border border-white/8 bg-black/20 px-4 py-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-gold/15 bg-gold/10 font-mono text-[10px] text-gold">
                        0{index + 1}
                      </div>
                      <span className="font-display text-[1.08rem] font-medium tracking-[-0.03em] text-platinum">
                        {step.label}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold/90">
                      {step.price}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[22px] border border-white/8 bg-black/20 p-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold/70">
                    Gateway
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-platinum">
                    Funded
                  </div>
                  <div className="mt-1 text-sm text-platinum-muted">
                    Ready before the pipeline starts.
                  </div>
                </div>

                <div className="rounded-[22px] border border-white/8 bg-black/20 p-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold/70">
                    Report
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-platinum">
                    Delivered
                  </div>
                  <div className="mt-1 text-sm text-platinum-muted">
                    Receipt trail and markdown output together.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="flow" className="py-20 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold/80">
              How it works
            </div>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-[-0.045em] text-platinum sm:text-5xl">
              AgentFlow makes AI execution
              <span className="block bg-gradient-to-r from-gold-light via-gold to-gold-dark bg-clip-text text-transparent">
                legible from wallet to report.
              </span>
            </h2>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {stages.map((stage) => (
              <article
                key={stage.index}
                className="rounded-[28px] border border-white/7 bg-white/[0.025] p-6 transition-all hover:-translate-y-1 hover:border-gold/18"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold/80">
                  {stage.index}
                </div>
                <h3 className="mt-4 font-display text-2xl font-semibold tracking-[-0.04em] text-platinum">
                  {stage.title}
                </h3>
                <p className="mt-4 text-sm leading-7 text-platinum-muted">
                  {stage.copy}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {featureCards.map((card) => (
              <article
                key={card.title}
                className="rounded-[28px] border border-gold/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-6"
              >
                <h3 className="font-display text-xl font-semibold tracking-[-0.035em] text-gold">
                  {card.title}
                </h3>
                <p className="mt-4 text-sm leading-7 text-platinum-muted">
                  {card.copy}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-12 rounded-[30px] border border-gold/16 bg-[radial-gradient(circle_at_top_left,rgba(192,160,96,0.12),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-8 sm:p-10 lg:flex lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-gold/80">
                Ready to run
              </div>
              <h3 className="mt-4 font-display text-3xl font-semibold tracking-[-0.045em] text-platinum sm:text-4xl">
                Launch the console and run the full workflow.
              </h3>
              <p className="mt-4 text-base leading-7 text-platinum-muted">
                Connect a wallet, fund Gateway balance, and follow Research,
                Analyst, and Writer from first settlement to final report.
              </p>
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-0">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-full bg-gold px-7 py-3.5 text-base font-bold text-bg transition-all hover:-translate-y-0.5 hover:bg-gold-light"
              >
                Launch Console
              </Link>
              <Link
                href="#top"
                className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-7 py-3.5 text-base font-semibold text-platinum transition-all hover:border-gold/30 hover:text-gold"
              >
                Back to top
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
