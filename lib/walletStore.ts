import fs from 'fs';
import path from 'path';
import { getAddress } from 'viem';

export interface StoredWallet {
  circleWalletId: string;
  circleWalletAddress: string;
}

type WalletStore = Record<string, StoredWallet>;

const STORE_PATH = path.join(process.cwd(), 'wallets.json');

function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address.toLowerCase();
  }
}

export function loadWallets(): WalletStore {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw) as WalletStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[WalletStore] Failed to read wallets.json, starting empty.', e);
    return {};
  }
}

export function saveWallets(store: WalletStore): void {
  try {
    const data = JSON.stringify(store, null, 2);
    fs.writeFileSync(STORE_PATH, data, 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[WalletStore] Failed to write wallets.json.', e);
  }
}

export function getWalletForUser(address: string): StoredWallet | undefined {
  const normalized = normalizeAddress(address);
  const store = loadWallets();
  return store[normalized];
}

export function setWalletForUser(address: string, wallet: StoredWallet): void {
  const normalized = normalizeAddress(address);
  const store = loadWallets();
  store[normalized] = wallet;
  saveWallets(store);
}

