"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { parseUnits } from "viem";
import { useGatewayBalance } from "@/lib/hooks/useGatewayBalance";
import {
  ARC_CHAIN_ID,
  ARC_EXPLORER_URL,
  CIRCLE_FAUCET_URL,
  ARC_USDC_ADDRESS,
} from "@/lib/arcChain";
import { trackEvent } from "@/lib/ga";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

const PRESET_AMOUNTS = ["1", "2"];
const READY_GATEWAY_BALANCE = 0.016;

type GatewayFundingResponse = {
  funded?: boolean;
  message?: string;
  errorReason?: string;
  errorDetails?: string;
  approvalTxHash?: string;
  depositTxHash?: string;
};

export function Onboarding() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const chainId = useChainId();
  const { switchChain, isPending: isSwitchPending } = useSwitchChain();
  const { gatewayBalance, isLowBalance, refetch } = useGatewayBalance(address);

  const [switchError, setSwitchError] = useState<string | null>(null);
  const [circleWalletAddress, setCircleWalletAddress] = useState<string | null>(null);
  const [isCircleWalletLoading, setIsCircleWalletLoading] = useState(false);
  const [circleWalletError, setCircleWalletError] = useState<string | null>(null);
  const [isGatewayAutoFunding, setIsGatewayAutoFunding] = useState(false);
  const [gatewayAutoFundError, setGatewayAutoFundError] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("1");
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositTxHash, setDepositTxHash] = useState<string | null>(null);
  const [gatewayApprovalTxHash, setGatewayApprovalTxHash] = useState<string | null>(null);
  const [gatewayDepositTxHash, setGatewayDepositTxHash] = useState<string | null>(null);

  const isOnArc = chainId === ARC_CHAIN_ID;

  const refreshGatewayStatus = useCallback(async (): Promise<number> => {
    const result = await refetch();
    return result.data?.balance ?? 0;
  }, [refetch]);

  const applyFundingResponse = useCallback((funding: GatewayFundingResponse) => {
    setGatewayApprovalTxHash(funding.approvalTxHash ?? null);
    setGatewayDepositTxHash(funding.depositTxHash ?? null);
  }, []);

  useEffect(() => {
    if (isConnected && address) {
      trackEvent("wallet_connected", { wallet_address: address, timestamp: Date.now() });
    }
  }, [isConnected, address]);

  useEffect(() => {
    if (gatewayBalance >= READY_GATEWAY_BALANCE && gatewayAutoFundError) {
      setGatewayAutoFundError(null);
    }
  }, [gatewayBalance, gatewayAutoFundError]);

  useEffect(() => {
    if (!address || !isConnected) {
      setCircleWalletAddress(null);
      setCircleWalletError(null);
      setIsCircleWalletLoading(false);
      setIsGatewayAutoFunding(false);
      setGatewayAutoFundError(null);
      setGatewayApprovalTxHash(null);
      setGatewayDepositTxHash(null);
      return;
    }

    let cancelled = false;

    const syncCircleWallet = async () => {
      try {
        setIsCircleWalletLoading(true);
        setCircleWalletError(null);
        setIsGatewayAutoFunding(true);
        setGatewayAutoFundError(null);

        const response = await fetch(`${BACKEND_URL}/wallet/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userAddress: address }),
        });

        if (!response.ok) {
          const text = await response.text();
          if (!cancelled) setCircleWalletError(text || `Failed with ${response.status}`);
          return;
        }

        const data = (await response.json()) as { circleWalletAddress?: string };
        if (!cancelled) {
          const circleAddress = data.circleWalletAddress ?? null;
          setCircleWalletAddress(circleAddress);
          if (circleAddress && address) {
            trackEvent("circle_wallet_created", {
              wallet_address: address,
              circle_wallet_address: circleAddress,
              timestamp: Date.now(),
            });
          }
        }

        const fundResponse = await fetch(`${BACKEND_URL}/wallet/fund-gateway`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userAddress: address }),
        });

        if (!fundResponse.ok) {
          const text = await fundResponse.text();
          if (!cancelled) setGatewayAutoFundError(text || `Funding failed with ${fundResponse.status}`);
        } else {
          const funding = (await fundResponse.json()) as GatewayFundingResponse;
          if (!cancelled) {
            applyFundingResponse(funding);
          }
          if (!cancelled && funding.funded === false) {
            const latestBalance = await refreshGatewayStatus();
            if (cancelled) return;
            if (latestBalance < READY_GATEWAY_BALANCE) {
              setGatewayAutoFundError(
                funding.message ??
                funding.errorDetails ??
                funding.errorReason ??
                "Funding did not complete",
              );
            } else {
              setGatewayAutoFundError(null);
            }
          } else if (!cancelled) {
            await refreshGatewayStatus();
            if (cancelled) return;
            setGatewayAutoFundError(null);
            if (address) trackEvent("gateway_funded", { wallet_address: address, timestamp: Date.now() });
          }
        }
      } catch (e) {
        if (!cancelled) setCircleWalletError(e instanceof Error ? e.message : "Failed to create Circle wallet");
      } finally {
        if (!cancelled) {
          setIsCircleWalletLoading(false);
          setIsGatewayAutoFunding(false);
        }
      }
    };

    void syncCircleWallet();
    return () => { cancelled = true; };
  }, [address, applyFundingResponse, isConnected, refreshGatewayStatus]);

  const handleRetryFunding = async () => {
    if (!address) return;
    setIsGatewayAutoFunding(true);
    setGatewayAutoFundError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/wallet/fund-gateway`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress: address }),
      });
      if (!res.ok) {
        const text = await res.text();
        setGatewayAutoFundError(text || `Funding failed with ${res.status}`);
      } else {
        const funding = (await res.json()) as GatewayFundingResponse;
        applyFundingResponse(funding);
        if (funding.funded === false) {
          const latestBalance = await refreshGatewayStatus();
          if (latestBalance < READY_GATEWAY_BALANCE) {
            setGatewayAutoFundError(
              funding.message ??
              funding.errorDetails ??
              funding.errorReason ??
              "Funding did not complete",
            );
          } else {
            setGatewayAutoFundError(null);
          }
        } else {
          await refreshGatewayStatus();
          setGatewayAutoFundError(null);
        }
      }
    } catch (e) {
      setGatewayAutoFundError(e instanceof Error ? e.message : "Funding failed");
    } finally {
      setIsGatewayAutoFunding(false);
    }
  };

  const handleDeposit = async () => {
    if (!walletClient || !circleWalletAddress || !address) return;
    const amount = parseFloat(depositAmount);
    if (!amount || amount <= 0) return;

    setIsDepositing(true);
    setDepositError(null);
    setDepositTxHash(null);
    setGatewayApprovalTxHash(null);
    setGatewayDepositTxHash(null);

    try {
      const hash = await walletClient.writeContract({
        address: ARC_USDC_ADDRESS,
        abi: [{
          name: "transfer",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
          outputs: [{ name: "", type: "bool" }],
        }],
        functionName: "transfer",
        args: [circleWalletAddress as `0x${string}`, parseUnits(depositAmount, 6)],
      });

      setDepositTxHash(hash);
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await handleRetryFunding();
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setIsDepositing(false);
    }
  };

  if (!mounted) {
    return null;
  }

  const handleAddAndSwitchToArc = async () => {
    setSwitchError(null);
    try {
      await switchChain({ chainId: ARC_CHAIN_ID });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to switch network";
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("user denied")) {
        setSwitchError(msg);
      }
    }
  };

  const walletLinked = isConnected;
  const gatewayReady = !isLowBalance && gatewayBalance >= READY_GATEWAY_BALANCE;
  const numericDepositAmount = Number(depositAmount);
  const hasValidDepositAmount = Number.isFinite(numericDepositAmount) && numericDepositAmount > 0;
  const depositButtonLabel = hasValidDepositAmount
    ? `DEPOSIT ${depositAmount} USDC`
    : "ENTER AMOUNT";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className={`rounded-2xl border p-4 transition-colors ${
            walletLinked ? "border-gold/22 bg-gold/5" : "border-gold/14 bg-bg-tertiary/70"
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-widest text-platinum-muted">SEQ_01</span>
            {walletLinked && <span className="font-mono text-[10px] tracking-widest text-gold">[OK]</span>}
          </div>
          <div className="mb-2 text-lg font-semibold tracking-tight text-platinum">Wallet linked</div>
          {isConnected ? (
            <div className="space-y-2 pt-1">
              <div className="border-t border-white/8 pt-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-platinum-muted">
                  EOA
                </div>
              <div
                title={address}
                className="mt-1 break-all font-mono text-[10px] leading-5 text-platinum"
              >
                {address}
              </div>
            </div>
            {isCircleWalletLoading && (
              <div className="border-t border-white/8 pt-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-platinum-muted">
                  Circle wallet
                </div>
                <div className="mt-1 animate-pulse font-mono text-[10px] leading-5 text-platinum-muted">
                  Initializing Circle wallet...
                </div>
              </div>
            )}
            {!isCircleWalletLoading && circleWalletAddress && (
              <div className="border-t border-white/8 pt-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-platinum-muted">
                  Circle wallet
                </div>
                <div
                  title={circleWalletAddress}
                  className="mt-1 break-all font-mono text-[10px] leading-5 text-platinum"
                >
                  {circleWalletAddress}
                </div>
              </div>
            )}
            {circleWalletError && <div className="text-[10px] text-danger">{circleWalletError}</div>}
          </div>
          ) : (
            <div className="text-[10px] text-platinum-muted">Connect your wallet to begin setup.</div>
          )}
        </div>

        <div
          className={`rounded-2xl border p-4 transition-colors ${
            gatewayReady ? "border-gold/22 bg-gold/5" : "border-gold/14 bg-bg-tertiary/70"
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-widest text-platinum-muted">SEQ_02</span>
            {gatewayReady && <span className="font-mono text-[10px] tracking-widest text-gold">[OK]</span>}
          </div>
          <div className="mb-2 text-lg font-semibold tracking-tight text-platinum">
            {gatewayReady ? "Gateway funded" : "Gateway status"}
          </div>
          <div className="flex items-end gap-2">
            <span className={`text-3xl font-semibold tracking-tight ${gatewayReady ? "text-gold" : "text-platinum"}`}>
              {gatewayBalance !== null ? gatewayBalance.toFixed(3) : "--"}
            </span>
            <span className="pb-1 font-mono text-[10px] text-platinum-muted">USDC</span>
          </div>
          <div className="mt-2 text-sm leading-6 text-platinum-muted">
            {gatewayReady
              ? "Ready"
              : "Needs 0.016 USDC minimum."}
          </div>

          {isGatewayAutoFunding && (
            <div className="mt-2 animate-pulse text-sm text-platinum-muted">Funding gateway...</div>
          )}

          {gatewayAutoFundError && !isGatewayAutoFunding && !gatewayReady && (
            <div className="mt-3 space-y-2">
              <div className="text-[10px] leading-relaxed text-danger">{gatewayAutoFundError}</div>
              <button
                onClick={handleRetryFunding}
                className="w-full rounded border border-gold/20 px-3 py-2 font-mono text-[10px] tracking-widest text-gold/78 transition-colors hover:border-gold/50 hover:text-gold"
              >
                RETRY FUNDING
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-gold/14 bg-bg-tertiary/70 p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-widest text-platinum-muted">SEQ_03</span>
        </div>
        <div className="mb-1 text-xl font-semibold tracking-tight text-platinum">Fund Circle Wallet</div>

        {circleWalletAddress ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 font-mono text-[10px] text-platinum-muted">Amount (USDC)</div>
              <div className="grid grid-cols-3 gap-2">
                {PRESET_AMOUNTS.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setDepositAmount(amt)}
                    className={`rounded border px-0 py-2 font-mono text-[10px] transition-colors ${
                      depositAmount === amt
                        ? "border-gold bg-gold/10 text-gold"
                        : "border-gold/14 text-platinum-muted hover:border-gold/40 hover:text-gold"
                    }`}
                  >
                    {amt}
                  </button>
                ))}
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    inputMode="decimal"
                    value={PRESET_AMOUNTS.includes(depositAmount) ? "" : depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    placeholder="Custom"
                    className="rounded border border-gold/14 bg-transparent px-2 py-2 text-center font-mono text-[10px] text-platinum placeholder:text-white/25 focus:border-gold/50 focus:outline-none"
                  />
                </div>
              </div>

            <button
              onClick={handleDeposit}
              disabled={isDepositing || !walletClient || !hasValidDepositAmount}
              className="w-full rounded border border-gold/60 px-3 py-2.5 font-mono text-[10px] font-bold tracking-widest text-gold transition-colors hover:bg-gold hover:text-bg disabled:opacity-40"
            >
              {isDepositing ? "CONFIRMING..." : depositButtonLabel}
            </button>

            {(depositTxHash || gatewayApprovalTxHash || gatewayDepositTxHash) && !depositError && (
              <div className="space-y-1.5 border-t border-gold/10 pt-3">
                {depositTxHash && (
                  <a
                    href={`${ARC_EXPLORER_URL}/tx/${depositTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-fit items-center gap-2 truncate font-mono text-[10px] text-success transition-colors hover:text-gold"
                    title={depositTxHash}
                  >
                    <span className="text-platinum-muted">Wallet → Circle:</span>
                    <span>{depositTxHash.slice(0, 20)}...</span>
                  </a>
                )}
                {gatewayApprovalTxHash && (
                  <a
                    href={`${ARC_EXPLORER_URL}/tx/${gatewayApprovalTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-fit items-center gap-2 truncate font-mono text-[10px] text-gold/78 transition-colors hover:text-gold"
                    title={gatewayApprovalTxHash}
                  >
                    <span className="text-platinum-muted">Circle → Gateway approve:</span>
                    <span>{gatewayApprovalTxHash.slice(0, 20)}...</span>
                  </a>
                )}
                {gatewayDepositTxHash && (
                  <a
                    href={`${ARC_EXPLORER_URL}/tx/${gatewayDepositTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-fit items-center gap-2 truncate font-mono text-[10px] text-gold transition-colors hover:text-gold-light"
                    title={gatewayDepositTxHash}
                  >
                    <span className="text-platinum-muted">Circle → Gateway deposit:</span>
                    <span>{gatewayDepositTxHash.slice(0, 20)}...</span>
                  </a>
                )}
              </div>
            )}
            {depositError && <div className="text-sm leading-6 text-danger">{depositError}</div>}

            <div className="border-t border-gold/10 pt-3">
              <div className="mb-2 text-sm text-platinum-muted">
                Need test USDC?
              </div>
              <a
                href={CIRCLE_FAUCET_URL}
                target="_blank"
                rel="noreferrer"
                className="block rounded border border-gold/14 px-3 py-2 text-center font-mono text-[10px] tracking-widest text-gold/72 transition-colors hover:border-gold/40 hover:text-gold"
              >
                {"OPEN FAUCET ->"}
              </a>
            </div>
          </div>
        ) : (
          <div className="animate-pulse text-sm text-platinum-muted">Waiting for wallet...</div>
        )}
      </div>

      {!isOnArc && isConnected && (
        <div className="space-y-2 rounded-lg border border-danger/30 bg-danger/10 p-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm tracking-wide text-danger">
              [WARN] Wrong network - switch to Arc Testnet
            </span>
            <button
              onClick={handleAddAndSwitchToArc}
              disabled={isSwitchPending}
              className="whitespace-nowrap rounded border border-danger/50 px-4 py-1.5 font-mono text-[10px] tracking-widest text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
            >
              {isSwitchPending ? "SWITCHING..." : "SWITCH NOW"}
            </button>
          </div>
          {switchError && <div className="text-sm text-danger">{switchError}</div>}
        </div>
      )}
    </div>
  );
}
