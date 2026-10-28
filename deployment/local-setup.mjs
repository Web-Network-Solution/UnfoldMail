import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
try {
  writeFileSync('.dev.vars', `BOOTSTRAP_SECRET=${randomBytes(32).toString('hex')}\nEMAIL_DOMAIN=example.test\nAPP_URL=http://localhost:8787\nENVIRONMENT=development\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .dev.vars. Use its BOOTSTRAP_SECRET during local first-admin setup.');
} catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Keeping existing .dev.vars.'); }
mkdirSync('packages/web/dist', { recursive: true });
