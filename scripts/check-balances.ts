import dotenv from 'dotenv';
import { GatewayClient } from '@circlefin/x402-batching/client';

dotenv.config();

async function main() {
  let privateKey = process.env.PRIVATE_KEY?.trim();
  if (!privateKey) {
    console.error('PRIVATE_KEY is not set in environment.');
    process.exit(1);
  }
  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const client = new GatewayClient({
    chain: 'arcTestnet',
    privateKey,
  });

  const balances = await client.getBalances();
  console.log('Wallet + Gateway balances on Arc Testnet:');
  console.log(`- Wallet USDC:    ${balances.wallet.formattedTotal}`);
  console.log(`- Gateway total:  ${balances.gateway.formattedTotal}`);
  console.log(`- Gateway avail.: ${balances.gateway.formattedAvailable}`);
}

main().catch((err) => {
  console.error('Check-balances script failed:', err);
  process.exit(1);
});

