"use client";

import { useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { getAddress, parseUnits } from "viem";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import {
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  ARC_EXPLORER_URL,
  ARC_USDC_ADDRESS,
  CIRCLE_FAUCET_URL,
  GATEWAY_WALLET_ADDRESS,
} from "@/lib/arcChain";

const ARC_ADD_CHAIN_PARAMS = {
  chainId: ARC_CHAIN_ID_HEX,
  chainName: "Arc Testnet",
  rpcUrls: ["https://rpc.testnet.arc.network"],
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const gatewayWalletAbi = [
  {
    type: "function",
    name: "depositFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export function Onboarding() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const chainId = useChainId();
  const { switchChain, isPending: isSwitchPending } = useSwitchChain();
  const { gatewayBalance, isLowBalance, refetch } = useGatewayBalance(address);
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState<
    "idle" | "pending" | "success" | "error"
  >("idle");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositTxHash, setDepositTxHash] = useState<string | null>(null);
  const [addChainPending, setAddChainPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const isOnArc = chainId === ARC_CHAIN_ID;

  const handleAddAndSwitchToArc = async () => {
    const provider = (typeof window !== "undefined" &&
      (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum) as
      | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
      | undefined;
    if (!provider) {
      setSwitchError("No wallet found. Install MetaMask.");
      return;
    }
    setAddChainPending(true);
    setSwitchError(null);
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [ARC_ADD_CHAIN_PARAMS],
      });
      await switchChain?.({ chainId: ARC_CHAIN_ID });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add or switch network";
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("user denied")) {
        setSwitchError(msg);
      }
    } finally {
      setAddChainPending(false);
    }
  };
  const step1Done = isConnected;
  const step2Done = isOnArc;
  const step3Done = true;
  const step4Done = !isLowBalance && gatewayBalance >= 0.016;
  const allDone = step1Done && step2Done && step4Done;

  const handleDeposit = async () => {
    setDepositStatus("pending");
    setDepositError(null);
    setDepositTxHash(null);
    try {
      if (!address) {
        throw new Error("Connect your wallet first.");
      }
      if (!walletClient || !publicClient) {
        throw new Error("Wallet client is not ready. Reconnect MetaMask.");
      }
      if (!isOnArc) {
        throw new Error("Switch to Arc Testnet before depositing.");
      }

      const depositor = getAddress(address);
      const amountInput = (depositAmount || "1").trim();
      const amount = parseUnits(amountInput, 6);
      if (amount <= BigInt(0)) {
        throw new Error("Deposit amount must be greater than 0.");
      }

      const allowance = await publicClient.readContract({
        address: ARC_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [depositor, GATEWAY_WALLET_ADDRESS],
      });

      if (allowance < amount) {
        const approvalTx = await walletClient.writeContract({
          account: depositor,
          address: ARC_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [GATEWAY_WALLET_ADDRESS, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: approvalTx });
      }

      const depositTx = await walletClient.writeContract({
        account: depositor,
        address: GATEWAY_WALLET_ADDRESS,
        abi: gatewayWalletAbi,
        functionName: "depositFor",
        args: [ARC_USDC_ADDRESS, depositor, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositTx });

      setDepositTxHash(depositTx);
      setDepositStatus("success");
      refetch();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Deposit failed";
      if (
        message.toLowerCase().includes("rejected") ||
        message.toLowerCase().includes("user denied")
      ) {
        setDepositError("MetaMask transaction was rejected.");
      } else {
        setDepositError(message);
      }
      setDepositStatus("error");
    }
  };

  if (allDone) return null;

  return (
    <div className="rounded-xl bg-gradient-to-br from-[var(--surface)] to-black/60 border border-white/10 p-5 mb-6">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
        4-Step Onboarding
      </h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          className={`p-4 rounded-lg border ${
            step1Done
              ? "border-[var(--success)]/50 bg-[var(--success)]/5"
              : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 1
          </div>
          <div className="text-sm font-medium">
            {step1Done ? "Connected MetaMask" : "Connect MetaMask"}
          </div>
          <p className="text-xs text-[var(--muted)] mt-1">
            Use the Connect button above
          </p>
        </div>

        <div
          className={`p-4 rounded-lg border ${
            step2Done
              ? "border-[var(--success)]/50 bg-[var(--success)]/5"
              : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 2
          </div>
          <div className="text-sm font-medium">
            {step2Done ? "Arc Testnet selected" : "Switch to Arc Testnet"}
          </div>
          {!step2Done && (
            <button
              onClick={handleAddAndSwitchToArc}
              disabled={isSwitchPending || addChainPending}
              className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSwitchPending || addChainPending ? "Switching..." : "Switch Network"}
            </button>
          )}
        </div>

        <div className="p-4 rounded-lg border border-white/10">
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 3
          </div>
          <div className="text-sm font-medium">Get testnet USDC</div>
          <a
            href={CIRCLE_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs px-3 py-1.5 rounded-lg bg-accent/20 text-accent hover:bg-accent/30"
          >
            Open Faucet
          </a>
        </div>

        <div
          className={`p-4 rounded-lg border ${
            step4Done
              ? "border-[var(--success)]/50 bg-[var(--success)]/5"
              : "border-white/10"
          }`}
        >
          <div className="text-xs font-medium text-[var(--muted)] mb-1">
            Step 4
          </div>
          <div className="text-sm font-medium">
            {step4Done ? "Gateway funded" : "Deposit to Gateway"}
          </div>
          {!step4Done && (
            <div className="mt-2 flex gap-2 items-center">
              <input
                type="text"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="1"
                className="w-16 px-2 py-1 rounded bg-black/40 border border-white/10 text-sm"
              />
              <button
                onClick={handleDeposit}
                disabled={depositStatus === "pending"}
                className="text-xs px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
              >
                {depositStatus === "pending" ? "Confirm in wallet..." : "Deposit"}
              </button>
            </div>
          )}
          {depositStatus === "success" && depositTxHash && (
            <p className="text-xs text-[var(--success)] mt-1">
              Deposited.{" "}
              <a
                href={`${ARC_EXPLORER_URL}/tx/${depositTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                View on Arcscan
              </a>
            </p>
          )}
          {depositError && (
            <p className="text-xs text-[var(--danger)] mt-1">{depositError}</p>
          )}
        </div>
      </div>

      {!isOnArc && isConnected && (
        <div className="mt-4 p-3 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--danger)]">
              Wrong network. Switch to Arc Testnet to continue.
            </span>
            <button
              onClick={handleAddAndSwitchToArc}
              disabled={isSwitchPending || addChainPending}
              className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {isSwitchPending || addChainPending ? "Switching..." : "Switch to Arc Testnet"}
            </button>
          </div>
          {switchError && (
            <p className="text-xs text-[var(--danger)]">{switchError}</p>
          )}
        </div>
      )}
    </div>
  );
}
