"use client";

import { ARC_EXPLORER_URL } from "@/lib/arcChain";

export interface ReceiptData {
  researchTx?: string;
  analystTx?: string;
  writerTx?: string;
  total?: string;
}

export function Receipt({
  data,
  isLowBalance,
}: {
  data?: ReceiptData | null;
  isLowBalance?: boolean;
}) {
  const researchTx = data?.researchTx;
  const analystTx = data?.analystTx;
  const writerTx = data?.writerTx;
  const total = data?.total ?? "0.016";

  const TxLink = ({ hash, label }: { hash?: string; label: string }) =>
    hash ? (
      <a
        href={`${ARC_EXPLORER_URL}/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        className="text-accent hover:underline text-xs truncate max-w-[180px] block"
      >
        {hash.slice(0, 10)}...
      </a>
    ) : (
      <span className="text-xs text-[var(--muted)]">—</span>
    );

  return (
    <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
        Payment Receipt
      </div>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-[var(--muted)]">Research Agent</span>
          <span>$0.005</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--muted)]">Analyst Agent</span>
          <span>$0.003</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--muted)]">Writer Agent</span>
          <span>$0.008</span>
        </div>
        <div className="flex justify-between text-sm font-semibold pt-2 border-t border-white/10">
          <span>Total paid</span>
          <span>${total} USDC</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[var(--muted)]">Gas fees</span>
          <span className="text-[var(--success)]">$0.000 (gasless)</span>
        </div>
        <div className="pt-2 border-t border-white/10">
          <div className="text-xs text-[var(--muted)] mb-1">Transactions</div>
          <div className="space-y-1 text-xs">
            <div>
              Research: <TxLink hash={researchTx} label="Research" />
            </div>
            <div>
              Analyst: <TxLink hash={analystTx} label="Analyst" />
            </div>
            <div>
              Writer: <TxLink hash={writerTx} label="Writer" />
            </div>
          </div>
        </div>
      </div>
      {isLowBalance && (
        <div className="mt-4 p-2 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30 text-xs text-[var(--danger)]">
          Gateway balance low. Deposit more USDC to run.
        </div>
      )}
    </div>
  );
}
