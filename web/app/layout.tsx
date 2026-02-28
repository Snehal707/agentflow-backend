import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "AgentFlow – Autonomous AI agents. Instant payments. Zero gas.",
  description:
    "AgentFlow — Autonomous AI agents on Arc Testnet. Circle x402 · Hermes AI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
