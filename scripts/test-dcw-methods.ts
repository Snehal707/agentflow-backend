import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  // eslint-disable-next-line no-console
  console.error('Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env');
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey,
  entitySecret,
  environment: 'sandbox',
});

// eslint-disable-next-line no-console
console.log('All DCW client methods:');

const proto = Object.getPrototypeOf(client);
const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');

// eslint-disable-next-line no-console
console.log(methods);

