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
      const params = address ? new URLSearchParams({ address }) : "";
      const url = `${BACKEND_URL}/gateway-balance${params ? `?${params}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const balance = parseFloat(json.balance || json.formatted || "0");
      return { balance, formatted: json.formatted || json.balance };
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
