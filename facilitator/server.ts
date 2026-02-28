import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import {
  BatchFacilitatorClient,
  isBatchPayment,
} from '@circlefin/x402-batching/server';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number(process.env.FACILITATOR_PORT) || 3000;
const gatewayClient = new BatchFacilitatorClient();

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function requestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/v1/x402/supported', async (_req: Request, res: Response) => {
  const rid = requestId('supported');
  try {
    const result = await gatewayClient.getSupported();
    console.log(`[Facilitator ${rid}] supported ok`);
    return res.json(result);
  } catch (err) {
    const details = getErrorMessage(err);
    console.error(`[Facilitator ${rid}] Error in /v1/x402/supported`, err);
    return res
      .status(500)
      .json({ error: 'Internal error during getSupported', details, requestId: rid });
  }
});

app.post('/v1/x402/verify', async (req: Request, res: Response) => {
  const rid = requestId('verify');
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res
        .status(400)
        .json({ error: 'Missing payment data', requestId: rid });
    }
    if (!isBatchPayment(paymentRequirements)) {
      return res
        .status(400)
        .json({
          error: 'Only Gateway batched payments are supported',
          requestId: rid,
        });
    }
    console.log(`[Facilitator ${rid}] verify start`);
    const result = await gatewayClient.verify(paymentPayload, paymentRequirements);
    if (!result.success) {
      console.error(
        `[Facilitator ${rid}] verify failed`,
        result.errorReason ?? result,
      );
    } else {
      console.log(`[Facilitator ${rid}] verify success`);
    }
    return res.json(result);
  } catch (err) {
    const details = getErrorMessage(err);
    console.error(`[Facilitator ${rid}] Error in /v1/x402/verify`, err);
    return res
      .status(500)
      .json({ error: 'Internal error during verify', details, requestId: rid });
  }
});

app.post('/v1/x402/settle', async (req: Request, res: Response) => {
  const rid = requestId('settle');
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res
        .status(400)
        .json({ error: 'Missing payment data', requestId: rid });
    }
    if (!isBatchPayment(paymentRequirements)) {
      return res
        .status(400)
        .json({
          error: 'Only Gateway batched payments are supported',
          requestId: rid,
        });
    }
    console.log(`[Facilitator ${rid}] settle start`);
    const result = await gatewayClient.settle(paymentPayload, paymentRequirements);
    if (!result.success) {
      console.error(
        `[Facilitator ${rid}] settle failed`,
        result.errorReason ?? result,
      );
    } else {
      console.log(`[Facilitator ${rid}] settle success`);
    }
    return res.json(result);
  } catch (err) {
    const details = getErrorMessage(err);
    console.error(`[Facilitator ${rid}] Error in /v1/x402/settle`, err);
    return res
      .status(500)
      .json({ error: 'Internal error during settle', details, requestId: rid });
  }
});

app.listen(PORT, () => {
  console.log(`Facilitator listening on http://localhost:${PORT}`);
});
