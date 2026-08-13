// Mints the Google refresh token for the API oracles (Gmail/Calendar/Drive).
// Needs an OAuth "Desktop app" client in a Google Cloud project owned by the
// eval account, with the Gmail/Calendar/Drive APIs enabled:
//
//   NFF_EVALS_GOOGLE_CLIENT_ID / NFF_EVALS_GOOGLE_CLIENT_SECRET in .env.evals
//   npm run setup:google -w @nff-brain/evals
//
// Opens the consent URL, catches the loopback redirect, writes .auth/google.json.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

function loadEnvFile(): void {
  const p = path.join(EVALS_ROOT, '.env.evals');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const clientId = process.env.NFF_EVALS_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.NFF_EVALS_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('set NFF_EVALS_GOOGLE_CLIENT_ID / NFF_EVALS_GOOGLE_CLIENT_SECRET in .env.evals first');
    process.exit(1);
  }

  const { google } = await import('googleapis');
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  const client = new google.auth.OAuth2(clientId, clientSecret, redirect);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('Open this URL in the browser logged into the EVAL Google account:\n\n' + url + '\n');

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirect);
      const c = u.searchParams.get('code');
      res.end(c ? 'Done — you can close this tab.' : 'No code in callback.');
      if (c) resolve(c);
      else reject(new Error('callback carried no code'));
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error('Google returned no refresh_token — remove the app from the account\'s third-party access and retry.');
    process.exit(1);
  }
  const out = path.join(EVALS_ROOT, '.auth', 'google.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ clientId, clientSecret, refreshToken: tokens.refresh_token }, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
