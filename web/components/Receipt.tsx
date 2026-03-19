"use client";

import { ARC_EXPLORER_URL } from "@/lib/arcChain";
import {
  formatTransactionReference,
  isOnchainTransactionHash,
} from "@/lib/transactions";

export interface ReceiptData {
  researchTx?: string;
  analystTx?: string;
  writerTx?: string;
  total?: string;
}

const LINE_ITEMS = [
  { key: "research", label: "Research agent", amount: "0.005" },
  { key: "analyst", label: "Analyst agent", amount: "0.003" },
  { key: "writer", label: "Writer agent", amount: "0.008" },
] as const;

function ExplorerLink({ hash }: { hash?: string }) {
  if (!hash) {
    return <span className="font-mono text-[10px] text-white/45">Pending</span>;
  }

  if (!isOnchainTransactionHash(hash)) {
    return (
      <span
        className="font-mono text-[10px] text-gold/48"
        title={`Gateway batch settlement reference: ${hash}`}
      >
        Batch {formatTransactionReference(hash)}
      </span>
    );
  }

  return (
    <a
      href={`${ARC_EXPLORER_URL}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[10px] text-gold/60 transition-colors hover:text-gold"
      title={hash}
    >
      {formatTransactionReference(hash)}
    </a>
  );
}

export function Receipt({
  data,
  isLowBalance,
}: {
  data?: ReceiptData | null;
  isLowBalance?: boolean;
}) {
  const total = data?.total ?? "0.016";
  const transactionMap = {
    research: data?.researchTx,
    analyst: data?.analystTx,
    writer: data?.writerTx,
  } as const;

  return (
    <div className="flex flex-col text-sm text-white/72">
      <div className="flex flex-col gap-4 border-b border-gold/10 pb-6">
        {LINE_ITEMS.map((item) => (
          <div key={item.key} className="flex items-center justify-between">
            <span className="text-white/78">{item.label}</span>
            <span className="tabular-nums text-sm font-medium text-white">${item.amount}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-2">
          <span className="text-white/50">Network fee</span>
          <span className="tabular-nums text-sm text-white/55">$0.000</span>
        </div>
      </div>

      <div className="flex items-center justify-between py-6">
        <span className="text-lg font-medium text-white">Total charged</span>
        <span className="tabular-nums text-2xl font-semibold text-gold">${total}</span>
      </div>

      <div className="flex flex-col gap-4 border-t border-gold/10 pt-6">
        <div className="mb-1 text-sm font-medium text-gold/78">
          Transactions
        </div>
        {LINE_ITEMS.map((item) => (
          <div key={item.key} className="flex items-center justify-between">
            <span className="text-sm text-white/58">{item.label}</span>
            <ExplorerLink hash={transactionMap[item.key]} />
          </div>
        ))}
      </div>

      {isLowBalance && (
        <div className="mt-8 text-sm italic text-gold/80">
          Gateway balance is low. Top up before the next run.
        </div>
      )}
    </div>
  );
}
