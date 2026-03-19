"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  okxWallet,
  rainbowWallet,
  coinbaseWallet,
  subWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./arcChain";

if (!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID === "agentflow-demo") {
  console.warn(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set. Get one at https://cloud.walletconnect.com"
  );
}

type InjectedProvider = {
  isMetaMask?: boolean;
  isSubWallet?: boolean;
  isApexWallet?: boolean;
  isAvalanche?: boolean;
  isBackpack?: boolean;
  isBifrost?: boolean;
  isBitKeep?: boolean;
  isBitski?: boolean;
  isBinance?: boolean;
  isBlockWallet?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isDawn?: boolean;
  isEnkrypt?: boolean;
  isExodus?: boolean;
  isFrame?: boolean;
  isFrontier?: boolean;
  isGamestop?: boolean;
  isHyperPay?: boolean;
  isImToken?: boolean;
  isKuCoinWallet?: boolean;
  isMathWallet?: boolean;
  isNestWallet?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  isOneInchIOSWallet?: boolean;
  isOneInchAndroidWallet?: boolean;
  isOpera?: boolean;
  isPhantom?: boolean;
  isPortal?: boolean;
  isRainbow?: boolean;
  isRabby?: boolean;
  isSafePal?: boolean;
  isStatus?: boolean;
  isTalisman?: boolean;
  isTally?: boolean;
  isTokenPocket?: boolean;
  isTokenary?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isCTRL?: boolean;
  isZeal?: boolean;
  isCoin98?: boolean;
  isMEWwallet?: boolean;
  isWigwam?: boolean;
  isZerion?: boolean;
  __seif?: boolean;
  _events?: unknown;
  _state?: unknown;
  providers?: InjectedProvider[];
  request?: (...args: unknown[]) => Promise<unknown>;
};

const isRealMetaMaskProvider = (provider?: InjectedProvider) => {
  if (!provider?.isMetaMask) return false;
  if (provider.isSubWallet) return false;
  if (provider.isBraveWallet && !provider._events && !provider._state) return false;

  const masqueradingFlags = [
    "isApexWallet",
    "isAvalanche",
    "isBackpack",
    "isBifrost",
    "isBitKeep",
    "isBitski",
    "isBinance",
    "isBlockWallet",
    "isCoinbaseWallet",
    "isDawn",
    "isEnkrypt",
    "isExodus",
    "isFrame",
    "isFrontier",
    "isGamestop",
    "isHyperPay",
    "isImToken",
    "isKuCoinWallet",
    "isMathWallet",
    "isNestWallet",
    "isOkxWallet",
    "isOKExWallet",
    "isOneInchIOSWallet",
    "isOneInchAndroidWallet",
    "isOpera",
    "isPhantom",
    "isPortal",
    "isRainbow",
    "isRabby",
    "isSafePal",
    "isStatus",
    "isTalisman",
    "isTally",
    "isTokenPocket",
    "isTokenary",
    "isTrust",
    "isTrustWallet",
    "isCTRL",
    "isZeal",
    "isCoin98",
    "isMEWwallet",
    "isWigwam",
    "isZerion",
    "__seif",
  ] as const;

  return masqueradingFlags.every((flag) => !provider[flag]);
};

const getRealMetaMaskProvider = (browserWindow?: Window) => {
  const ethereum = (browserWindow as Window & { ethereum?: InjectedProvider } | undefined)?.ethereum;
  const providers = ethereum?.providers?.length ? ethereum.providers : ethereum ? [ethereum] : [];
  return providers.find(isRealMetaMaskProvider);
};

const hardenedMetaMaskWallet = (parameters: Parameters<typeof metaMaskWallet>[0]) => {
  const wallet = metaMaskWallet(parameters);

  return {
    ...wallet,
    installed:
      typeof window !== "undefined"
        ? Boolean(getRealMetaMaskProvider(window))
        : wallet.installed,
    createConnector: (walletDetails: Parameters<typeof wallet.createConnector>[0]) => {
      if (typeof window === "undefined" || !getRealMetaMaskProvider(window)) {
        return wallet.createConnector(walletDetails);
      }

      return (config: Parameters<ReturnType<typeof wallet.createConnector>>[0]) => ({
        ...injected({
          shimDisconnect: true,
          target: () => {
            const provider = getRealMetaMaskProvider(window);
            if (!provider) return undefined;

            return {
              id: "metaMask",
              name: "MetaMask",
              provider,
            };
          },
        })(config),
        ...walletDetails,
      });
    },
  };
};

export const config = getDefaultConfig({
  appName: "AgentFlow",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!,
  chains: [arcTestnet],
  wallets: [
    {
      groupName: "Recommended",
      wallets: [
        hardenedMetaMaskWallet,
        subWallet,
        okxWallet,
        rainbowWallet,
        coinbaseWallet,
        walletConnectWallet,
      ],
    },
  ],
});
