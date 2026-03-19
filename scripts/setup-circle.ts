import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

dotenv.config();

async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    console.error(
      '[CircleSetup] CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET are required in .env before running this script.',
    );
    process.exit(1);
  }

  console.log('[CircleSetup] Initializing Developer-Controlled Wallets client with existing entity secret...');
  const dcwClient = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  console.log('[CircleSetup] Creating AgentFlow wallet set...');
  const walletSetResponse = await dcwClient.createWalletSet({
    name: 'AgentFlow',
  });

  const walletSetId = walletSetResponse.data?.walletSet?.id;
  if (!walletSetId) {
    console.error('[CircleSetup] Failed to create wallet set. Response:', walletSetResponse);
    process.exit(1);
  }

  console.log(`[CircleSetup] Created wallet set AgentFlow with id=${walletSetId}.`);

  const envPath = path.join(process.cwd(), '.env');
  let envContents = '';
  if (fs.existsSync(envPath)) {
    envContents = fs.readFileSync(envPath, 'utf8');
  }

  if (!/^\s*CIRCLE_WALLET_SET_ID\s*=/.m.test(envContents)) {
    const prefix = envContents && !envContents.endsWith('\n') ? '\n' : '';
    const line = `CIRCLE_WALLET_SET_ID=${walletSetId}`;
    fs.writeFileSync(envPath, envContents + prefix + line + '\n', 'utf8');
    console.log('[CircleSetup] Appended to .env:\n' + line);
  } else {
    console.log('[CircleSetup] CIRCLE_WALLET_SET_ID already present in .env; not overwriting.');
  }

  console.log('[CircleSetup] Done.');
}

main().catch((err) => {
  console.error('[CircleSetup] Failed:', err);
  process.exit(1);
});

