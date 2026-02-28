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

if (!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID === "agentflow-demo") {
  console.warn(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set. Get one at https://cloud.walletconnect.com"
  );
}

export const config = getDefaultConfig({
  appName: "AgentFlow",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!,
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
