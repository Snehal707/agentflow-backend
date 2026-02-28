import express from 'express';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { createGatewayMiddleware } from '@circlefin/x402-batching/server';
import { callHermes } from '../../lib/hermes';

dotenv.config();

const app = express();
app.use(express.json());

const port = Number(process.env.WRITER_AGENT_PORT || 3003);
let privateKey = process.env.PRIVATE_KEY?.trim() ?? '';
if (privateKey && !privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
const account = privateKeyToAccount(privateKey as `0x${string}`);

const price =
  process.env.WRITER_AGENT_PRICE !== undefined
    ? `$${process.env.WRITER_AGENT_PRICE}`
    : '$0.008';

const facilitatorUrl = process.env.FACILITATOR_URL || 'http://localhost:3000';
const sellerAddress =
  (process.env.SELLER_ADDRESS?.trim() as `0x${string}`) || account.address;
const gateway = createGatewayMiddleware({
  sellerAddress,
  facilitatorUrl,
});

const SYSTEM_PROMPT = `You are a writer agent. Given research and analysis, write a clear, well-structured report. Use markdown formatting. Make it professional and readable. CRITICAL FORMATTING RULES: Never use > at the start of any line. Never use blockquote markdown. Write every sentence as plain paragraph text or bullet points with - only. If you use > anywhere it will break the output. Structure the report exactly as follows:
# [Topic] — Research Report
**Prepared by:** AgentFlow AI
---
## Executive Summary (2-3 sentence overview)
## Key Facts (clean bullet points)
## Recent Developments (paragraphs, no >)
## Data & Statistics (markdown table where appropriate)
## Analysis (analytical conclusions from analyst agent)
## Conclusion (final summary)
---`;

const runHandler = async (req: express.Request, res: express.Response) => {
  try {
    const research =
      (req.body?.research as string) ?? (req.query.research as string) ?? '';
    const analysis =
      (req.body?.analysis as string) ?? (req.query.analysis as string) ?? '';
    const combinedInput = `RESEARCH:\n${research}\n\nANALYSIS:\n${analysis}`;
    const result = await callHermes(SYSTEM_PROMPT, combinedInput);
    res.json({ research, analysis, result });
  } catch (err) {
    console.error('Writer agent error:', err);
    res.status(500).json({ error: 'Writer agent failed' });
  }
};
app.get('/run', gateway.require(price), runHandler);
app.post('/run', gateway.require(price), runHandler);

app.listen(port, () => {
  console.log(`Writer agent running on :${port}`);
});

