import { runOrchestrator } from '../lib/orchestrator';

async function main() {
  const task = process.argv.slice(2).join(' ');
  if (!task) {
    console.error('Usage: npm run dev:orchestrator -- "Your task here"');
    process.exit(1);
  }

  const { report, summary, receipt } = await runOrchestrator(task);

  console.log(`Starting agent economy flow for task: "${task}"`);

  console.log(''); // spacing
  console.log('╔══════════════════════════════════════╗');
  console.log('║        AGENT ECONOMY RECEIPT         ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║ Task: "${task}"`.padEnd(38) + '║');
  console.log('║                                      ║');
  console.log(
    `║ Research Agent    $${receipt.researchPrice} USDC  ✅    ║`,
  );
  console.log(`║   Tx: ${receipt.researchTx}`.padEnd(38) + '║');
  console.log(
    `║ Analyst Agent     $${receipt.analystPrice} USDC  ✅    ║`,
  );
  console.log(`║   Tx: ${receipt.analystTx}`.padEnd(38) + '║');
  console.log(
    `║ Writer Agent      $${receipt.writerPrice} USDC  ✅    ║`,
  );
  console.log(`║   Tx: ${receipt.writerTx}`.padEnd(38) + '║');
  console.log('║                                      ║');
  console.log(
    `║ Total Paid:       $${receipt.total} USDC        ║`,
  );
  console.log('║ Gas Fees:         $0.000 (gasless!)  ║');
  console.log('║                                      ║');
  console.log('║ View on Arc Explorer:                ║');
  console.log('║ https://testnet.arcscan.app          ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  console.log('# Final Report (from Writer Agent)');
  console.log(report);
  console.log('');
  console.log('# Orchestration Summary (Hermes)');
  console.log(summary);
}

main().catch((err: unknown) => {
  console.error('Orchestrator failed:', err);
  console.error('');
  console.error('Full error message:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error('Stack trace:');
    console.error(err.stack);
  }
  if (
    err &&
    typeof err === 'object' &&
    (String(err).includes('Payment settlement failed') || String(err).includes('Payment failed'))
  ) {
    console.error('');
    console.error('Tip: Ensure (1) Gateway has sufficient balance (run npm run script:deposit),');
    console.error('(2) Facilitator is running first (npm run dev:facilitator), then the 3 agents.');
    console.error('(3) Check facilitator and research/analyst/writer terminal logs for settle failure reason.');
  }
  process.exit(1);
});

