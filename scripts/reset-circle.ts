import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  generateEntitySecret,
  registerEntitySecretCiphertext,
  initiateDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';

/**
 * Reset Circle DCW entity secret and wallet set for this environment.
 *
 * Usage:
 *   npx tsx scripts/reset-circle.ts
 *
 * Prerequisite:
 *   - .env must contain a valid CIRCLE_API_KEY for your DCW project.
 *
 * Effect:
 *   - Generates a new entity secret via generateEntitySecret()
 *   - Registers it with Circle (recovery data under ./output)
 *   - Creates an "AgentFlow" wallet set
 *   - Overwrites CIRCLE_ENTITY_SECRET and CIRCLE_WALLET_SET_ID in .env
 */

dotenv.config();

async function main(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    console.error('[CircleReset] CIRCLE_API_KEY is required in .env before running this script.');
    process.exit(1);
  }

  console.log('[CircleReset] Generating new entity secret via generateEntitySecret()...');
  const entitySecret = generateEntitySecret();

  const recoveryDir = path.join(process.cwd(), 'output');
  if (!fs.existsSync(recoveryDir)) {
    fs.mkdirSync(recoveryDir, { recursive: true });
  }

  console.log('[CircleReset] Registering entity secret ciphertext with Circle...');
  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });
  console.log('[CircleReset] Entity secret registered. Recovery data saved under ./output.');

  console.log('[CircleReset] Initializing Developer-Controlled Wallets client...');
  const dcwClient = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  console.log('[CircleReset] Creating AgentFlow wallet set...');
  const walletSetResponse = await dcwClient.createWalletSet({
    name: 'AgentFlow',
  });

  const walletSetId = walletSetResponse.data?.walletSet?.id;
  if (!walletSetId) {
    console.error('[CircleReset] Failed to create wallet set. Response:', walletSetResponse);
    process.exit(1);
  }

  console.log(`[CircleReset] Created wallet set AgentFlow with id=${walletSetId}.`);

  const envPath = path.join(process.cwd(), '.env');
  let envContents = '';
  if (fs.existsSync(envPath)) {
    envContents = fs.readFileSync(envPath, 'utf8');
  }

  const lines = envContents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const withoutCircleLines = lines.filter(
    (line) =>
      !line.startsWith('CIRCLE_ENTITY_SECRET=') &&
      !line.startsWith('CIRCLE_WALLET_SET_ID='),
  );

  withoutCircleLines.push(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
  withoutCircleLines.push(`CIRCLE_WALLET_SET_ID=${walletSetId}`);

  const newEnv = withoutCircleLines.join('\n') + '\n';
  fs.writeFileSync(envPath, newEnv, 'utf8');

  console.log('[CircleReset] Updated .env with:');
  console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
  console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
  console.log('[CircleReset] Done.');
}

main().catch((err) => {
  console.error('[CircleReset] Failed:', err);
  process.exit(1);
});

