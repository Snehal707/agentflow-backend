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
  console.log(
    `Gateway Balance: available=${balances.gateway.formattedAvailable} USDC, total=${balances.gateway.formattedTotal} USDC`,
  );

  if (balances.gateway.available < 1000000n) {
    console.log('Depositing 1 USDC into Gateway on Arc Testnet...');
    await client.deposit('1');
    console.log('Deposit submitted.');
  } else {
    console.log('Sufficient balance available, no deposit needed.');
  }
}

main().catch((err) => {
  console.error('Deposit script failed:', err);
  process.exit(1);
});

