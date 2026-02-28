import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
    },
    public: {
      http: ["https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: "https://testnet.arcscan.app",
    },
  },
});

export const ARC_CHAIN_ID = 5042002;
export const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";
export const ARC_GATEWAY_DOMAIN = 26;
export const ARC_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;
export const GATEWAY_WALLET_ADDRESS =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
