#!/usr/bin/env node
/**
 * Pack the Next.js frontend for a separate repo (Option B).
 * Usage: node scripts/pack-frontend.js [destination]
 * Default destination: ../agentflow-frontend
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DEFAULT_DEST = path.join(ROOT, '..', 'agentflow-frontend');
const DEST = path.resolve(ROOT, process.argv[2] || DEFAULT_DEST);

const SKIP = new Set(['node_modules', '.next', '.vercel', '.git']);

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const name = path.basename(src);
    if (SKIP.has(name)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

const readme = `# AgentFlow Frontend

Next.js 14 + RainbowKit frontend for AgentFlow. Deploy to Vercel.

## Deploy to Vercel

1. Push this repo to GitHub.
2. [vercel.com](https://vercel.com) → New Project → Import this repo.
3. Add environment variable: \`NEXT_PUBLIC_BACKEND_URL\` = your Railway backend URL (e.g. \`https://your-app.railway.app\`).
4. Deploy.

## Local dev

\`\`\`bash
npm install
cp .env.local.example .env.local
# Edit .env.local: NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
npm run dev
\`\`\`

Open http://localhost:3005. Connect wallet (Arc Testnet) and use Run AgentFlow.
`;

function main() {
  if (fs.existsSync(DEST)) {
    console.error('Destination exists:', DEST);
    console.error('Remove it or use a different path: node scripts/pack-frontend.js /path/to/frontend');
    process.exit(1);
  }
  console.log('Copying web/ to', DEST);
  copyRecursive(WEB, DEST);
  fs.writeFileSync(path.join(DEST, 'README.md'), readme, 'utf8');
  if (!fs.existsSync(path.join(DEST, '.env.local.example'))) {
    fs.writeFileSync(
      path.join(DEST, '.env.local.example'),
      'NEXT_PUBLIC_BACKEND_URL=http://localhost:4000\n',
      'utf8'
    );
  }
  console.log('Done. Next steps:');
  console.log('  cd', DEST);
  console.log('  git init');
  console.log('  git add .');
  console.log('  git commit -m "Initial frontend"');
  console.log('  git remote add origin https://github.com/YOUR_USERNAME/agentflow-frontend.git');
  console.log('  git push -u origin main');
  console.log('Then in Vercel: Import repo → add NEXT_PUBLIC_BACKEND_URL → Deploy');
}

main();
