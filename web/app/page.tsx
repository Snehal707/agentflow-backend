import Link from "next/link";
import { Header } from "@/components/Header";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-bg">
      <Header showWallet={false} />
      <section className="relative pt-32 pb-20 flex flex-col items-center justify-center min-h-screen overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gold/10 via-bg to-bg -z-10" />

        <div className="text-center z-10 max-w-4xl px-4">
          <h1 className="text-5xl md:text-7xl font-bold text-platinum mb-6 tracking-tight">
            AI Research <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-gold via-gold-light to-gold">
              Pipeline.
            </span>
          </h1>
          <p className="text-xl text-platinum-muted mb-10 max-w-2xl mx-auto leading-relaxed">
            Run a Research → Analyst → Writer pipeline. Pay per step with gasless
            x402 USDC micropayments on Arc Testnet.
          </p>
          <Link
            href="/dashboard"
            className="inline-block px-10 py-4 bg-gold text-bg font-bold text-lg rounded-xl hover:bg-gold-light transition-all transform hover:scale-105 shadow-xl shadow-gold/20"
          >
            Launch Console
          </Link>
        </div>

        <div className="absolute bottom-0 w-full h-1/2 bg-gradient-to-t from-bg to-transparent z-0" />
      </section>
    </main>
  );
}
