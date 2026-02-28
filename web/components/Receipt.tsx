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
        className="text-gold hover:underline text-xs truncate max-w-[180px] block"
      >
        {hash.slice(0, 10)}...
      </a>
    ) : (
      <span className="text-xs text-platinum-muted">—</span>
    );

  return (
    <div className="space-y-3 flex-1 text-sm font-mono flex flex-col">
      <div className="space-y-3 flex-1 text-sm bg-bg-tertiary/80 p-4 rounded-lg border border-white/5">
        <div className="flex justify-between border-b border-white/5 pb-2 border-dashed">
          <span className="text-platinum-muted">RESEARCH_NODE</span>
          <span className="text-platinum">$0.005</span>
        </div>
        <div className="flex justify-between border-b border-white/5 pb-2 border-dashed">
          <span className="text-platinum-muted">ANALYST_NODE</span>
          <span className="text-platinum">$0.003</span>
        </div>
        <div className="flex justify-between border-b border-white/5 pb-2 border-dashed">
          <span className="text-platinum-muted">WRITER_NODE</span>
          <span className="text-platinum">$0.008</span>
        </div>
        <div className="flex justify-between font-bold text-gold pt-2">
          <span>TOTAL_DEBIT</span>
          <span>${total} USDC</span>
        </div>
        <div className="flex justify-between text-xs pt-2">
          <span className="text-platinum-muted">NET_GAS_FEE</span>
          <span className="text-success">$0.000</span>
        </div>
        <div className="pt-6 mt-4 border-t border-white/10">
          <div className="text-[10px] text-platinum-muted mb-2 uppercase tracking-wider">
            Transaction Hashes
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-platinum-muted">RSRCH:</span>
              <TxLink hash={researchTx} label="Research" />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-platinum-muted">ANLYS:</span>
              <TxLink hash={analystTx} label="Analyst" />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-platinum-muted">WRTER:</span>
              <TxLink hash={writerTx} label="Writer" />
            </div>
          </div>
        </div>
      </div>
      {isLowBalance && (
        <div className="mt-4 p-3 rounded bg-danger/10 border border-danger/30 text-xs text-danger text-center animate-pulse">
          WARNING: GATEWAY BALANCE CRITICAL
        </div>
      )}
    </div>
  );
}
