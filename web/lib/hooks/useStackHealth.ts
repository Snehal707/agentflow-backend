"use client";

import { useQuery } from "@tanstack/react-query";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export interface StackHealth {
  ok: boolean;
  facilitator: boolean;
  research: boolean;
  analyst: boolean;
  writer: boolean;
}

export function useStackHealth() {
  const { data, isLoading } = useQuery({
    queryKey: ["stack-health"],
    queryFn: async (): Promise<StackHealth> => {
      const res = await fetch(`${BACKEND_URL}/health/stack`);
      const json = await res.json();
      return json;
    },
    enabled: true,
    refetchInterval: 5000,
    staleTime: 3000,
  });

  return {
    stackHealth: data ?? null,
    isStackReady: data?.ok ?? false,
    isLoading,
  };
}
