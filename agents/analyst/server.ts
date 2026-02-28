import express from 'express';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { createGatewayMiddleware } from '@circlefin/x402-batching/server';
import { callHermes } from '../../lib/hermes';

dotenv.config();

const app = express();
app.use(express.json());

const port = Number(process.env.ANALYST_AGENT_PORT || 3002);
let privateKey = process.env.PRIVATE_KEY?.trim() ?? '';
if (privateKey && !privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const price =
  process.env.ANALYST_AGENT_PRICE !== undefined
    ? `$${process.env.ANALYST_AGENT_PRICE}`
    : '$0.003';

const facilitatorUrl = process.env.FACILITATOR_URL || 'http://localhost:3000';
const sellerAddress =
  (process.env.SELLER_ADDRESS?.trim() as `0x${string}`) || account.address;
const gateway = createGatewayMiddleware({
  sellerAddress,
  facilitatorUrl,
});

const SYSTEM_PROMPT = `You are an analyst agent. Given raw research data, extract key insights, identify patterns, and provide analytical conclusions. Return structured JSON. Do NOT start any line or sentence with the > symbol. Do NOT use blockquote formatting. Write in clean plain paragraphs.`;

const runHandler = async (req: express.Request, res: express.Response) => {
  try {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    const result = await callHermes(SYSTEM_PROMPT, research);
    res.json({ research, result });
  } catch (err) {
    console.error('Analyst agent error:', err);
    res.status(500).json({ error: 'Analyst agent failed' });
  }
};
app.get('/run', gateway.require(price), runHandler);
app.post('/run', gateway.require(price), runHandler);

app.listen(port, () => {
  console.log(`Analyst agent running on :${port}`);
});

