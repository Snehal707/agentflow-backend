/**
 * Loads .env into process.env and runs npm install.
 * Use this for first-time setup so CLOUDSMITH_TOKEN from .env is available to npm.
 * Run: npm run setup
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const envPath = path.join(process.cwd(), '.env');
try {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^([^=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  });
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('Warning: could not read .env:', e.message);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['install'], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

process.exit(result.status !== null ? result.status : 0);
