export type OrchestratorStep = 'research' | 'analyst' | 'writer';

export type StepEvent =
  | { type: 'step_start'; step: OrchestratorStep; price: string }
  | { type: 'step_complete'; step: OrchestratorStep; tx: string; amount: string }
  | {
      type: 'receipt';
      total: string;
      researchTx: string;
      analystTx: string;
      writerTx: string;
    }
  | { type: 'report'; markdown: string; summary: string }
  | { type: 'error'; message: string; step?: OrchestratorStep };

export interface OrchestratorReceipt {
  total: string;
  researchPrice: string;
  analystPrice: string;
  writerPrice: string;
  researchTx: string;
  analystTx: string;
  writerTx: string;
}

export interface OrchestratorResult {
  report: string;
  summary: string;
  receipt: OrchestratorReceipt;
}

export async function runOrchestrator(
  _task: string,
  _onEvent?: (event: StepEvent) => void,
): Promise<OrchestratorResult> {
  throw new Error(
    'Server-side orchestrator payment signing has been removed. Run the browser flow, where each x402 payment is signed by the connected MetaMask wallet.',
  );
}
