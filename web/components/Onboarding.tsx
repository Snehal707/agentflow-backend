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
  ARC_EXPLORER_URL,
  ARC_USDC_ADDRESS,
  CIRCLE_FAUCET_URL,
  GATEWAY_WALLET_ADDRESS,
} from "@/lib/arcChain";

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
  const [switchError, setSwitchError] = useState<string | null>(null);

  const isOnArc = chainId === ARC_CHAIN_ID;

  const handleAddAndSwitchToArc = async () => {
    setSwitchError(null);
    try {
      await switchChain({ chainId: ARC_CHAIN_ID });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add or switch network";
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("user denied")) {
        setSwitchError(msg);
      }
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
    <div className="rounded-xl p-0 mb-0 relative z-10">
      <div className="grid grid-cols-2 gap-4">
        <div
          className={`p-5 rounded-xl border font-mono transition-colors ${
            step1Done
              ? "border-success/30 bg-success/5"
              : "border-white/10 bg-bg-tertiary/80"
          }`}
        >
          <div className="text-[10px] text-platinum-muted mb-2 flex justify-between">
            <span>SEQ_01</span>
            {step1Done && <span className="text-success">[OK]</span>}
          </div>
          <div className="text-sm font-bold text-platinum mb-2">
            {step1Done ? "Wallet Linked" : "Connect Wallet"}
          </div>
        </div>

        <div
          className={`p-5 rounded-xl border font-mono transition-colors ${
            step2Done
              ? "border-success/30 bg-success/5"
              : "border-white/10 bg-bg-tertiary/80"
          }`}
        >
          <div className="text-[10px] text-platinum-muted mb-2 flex justify-between">
            <span>SEQ_02</span>
            {step2Done && <span className="text-success">[OK]</span>}
          </div>
          <div className="text-sm font-bold text-platinum mb-2">
            {step2Done ? "Network Synced" : "Switch to Arc"}
          </div>
          {!step2Done && (
            <button
              onClick={handleAddAndSwitchToArc}
              disabled={isSwitchPending}
              className="mt-2 w-full text-xs px-3 py-2 rounded bg-bg-tertiary border border-gold/50 text-gold hover:bg-gold hover:text-bg transition-colors disabled:opacity-50"
            >
              {isSwitchPending ? "SYNCING..." : "EXECUTE SWITCH"}
            </button>
          )}
        </div>

        <div className="p-5 rounded-xl border border-white/10 bg-bg-tertiary/80 font-mono">
          <div className="text-[10px] text-platinum-muted mb-2 flex justify-between">
            <span>SEQ_03</span>
          </div>
          <div className="text-sm font-bold text-platinum mb-2">Get Test USDC</div>
          <a
            href={CIRCLE_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block text-center text-xs px-3 py-2 rounded bg-bg-tertiary border border-gold/50 text-gold hover:bg-gold hover:text-bg transition-colors"
          >
            OPEN FAUCET
          </a>
        </div>

        <div
          className={`p-5 rounded-xl border font-mono transition-colors ${
            step4Done
              ? "border-success/30 bg-success/5"
              : "border-white/10 bg-bg-tertiary/80"
          }`}
        >
          <div className="text-[10px] text-platinum-muted mb-2 flex justify-between">
            <span>SEQ_04</span>
            {step4Done && <span className="text-success">[OK]</span>}
          </div>
          <div className="text-sm font-bold text-platinum mb-2">
            {step4Done ? "Gateway Funded" : "Fund Gateway"}
          </div>
          {!step4Done && (
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="1"
                className="w-16 px-2 py-1.5 rounded bg-bg border border-white/20 text-platinum text-sm focus:outline-none focus:border-gold/50"
              />
              <button
                onClick={handleDeposit}
                disabled={depositStatus === "pending"}
                className="flex-1 text-xs px-2 py-1.5 rounded bg-gold text-bg font-bold hover:bg-gold-light disabled:opacity-50"
              >
                {depositStatus === "pending" ? "AWAIT..." : "DEPOSIT"}
              </button>
            </div>
          )}
          {depositStatus === "success" && depositTxHash && (
            <p className="text-[10px] text-success mt-2 truncate">
              TX:{" "}
              <a
                href={`${ARC_EXPLORER_URL}/tx/${depositTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-platinum"
              >
                {depositTxHash.slice(0, 10)}...
              </a>
            </p>
          )}
          {depositError && (
            <p className="text-[10px] text-danger mt-2 leading-tight">
              {depositError}
            </p>
          )}
        </div>
      </div>

      {!isOnArc && isConnected && (
        <div className="mt-4 p-4 rounded-lg bg-danger/10 border border-danger/30 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono">
          <span className="text-xs text-danger">
            [WARN] Network mismatch. Handshake required with Arc Testnet.
          </span>
          <button
            onClick={handleAddAndSwitchToArc}
            disabled={isSwitchPending}
            className="px-4 py-2 rounded bg-danger/20 text-danger text-xs font-bold hover:bg-danger hover:text-white transition-colors disabled:opacity-50"
          >
            {isSwitchPending ? "PROCESSING..." : "FORCE SYNC"}
          </button>
          {switchError && (
            <p className="text-[10px] text-danger w-full sm:w-auto">
              {switchError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
