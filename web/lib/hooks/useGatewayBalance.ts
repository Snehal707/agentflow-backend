"use client";

import { useQuery } from "@tanstack/react-query";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const MIN_BALANCE = 0.016;

export function useGatewayBalance(address?: string | null) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["gateway-balance", address ?? "default"],
    queryFn: async () => {
      if (!address) {
        return { balance: 0, formatted: "0" };
      }
      // /circle-wallet/:userAddress maps EOA → Circle wallet → Gateway balance
      const res = await fetch(`${BACKEND_URL}/circle-wallet/${address}`);
      if (!res.ok) {
        return { balance: 0, formatted: "0" };
      }
      const json = await res.json();
      const balance = parseFloat(json.gatewayBalance ?? "0");
      return { balance, formatted: balance.toFixed(3) };
    },
    enabled: Boolean(address),
    staleTime: 5000,
    refetchInterval: 10000,
  });

  const balance = data?.balance ?? 0;
  const isLowBalance = balance < MIN_BALANCE;

  return {
    gatewayBalance: balance,
    formattedBalance: data?.formatted ?? "0",
    isLowBalance,
    isLoading,
    error,
    refetch,
  };
}
