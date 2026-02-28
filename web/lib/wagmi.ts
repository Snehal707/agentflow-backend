"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arcTestnet } from "./arcChain";

export const config = getDefaultConfig({
  appName: "AgentFlow",
  projectId:
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "agentflow-demo",
  chains: [arcTestnet],
});
