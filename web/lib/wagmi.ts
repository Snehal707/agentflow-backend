"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  okxWallet,
  rainbowWallet,
  coinbaseWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { arcTestnet } from "./arcChain";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
if (!projectId || projectId === "agentflow-demo") {
  console.warn(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set. Get one at https://cloud.walletconnect.com"
  );
}

export const config = getDefaultConfig({
  appName: "AgentFlow",
  projectId: projectId || "agentflow-demo",
  chains: [arcTestnet],
  wallets: [
    {
      groupName: "Recommended",
      wallets: [
        metaMaskWallet,
        okxWallet,
        rainbowWallet,
        coinbaseWallet,
        walletConnectWallet,
      ],
    },
  ],
});
