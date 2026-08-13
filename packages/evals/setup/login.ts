// One-time, human-in-the-loop profile warm-up. Opens a headed browser on the
// eval profile; YOU log in to each service (Google blocks scripted logins —
// that's the point of a warmed persistent profile). Close the window when done.
//
//   npm run setup:login -w @nff-brain/evals [-- --profile default]

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOGIN_PAGES = [
  'https://accounts.google.com/',
  'https://www.linkedin.com/login',
  'https://slack.com/signin',
  'https://www.notion.so/login',
];

async function main(): Promise<void> {
  const profile = process.argv.includes('--profile')
    ? process.argv[process.argv.indexOf('--profile') + 1]
    : 'default';
  const profileDir = path.join(EVALS_ROOT, '.profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, { headless: false });
  for (const url of LOGIN_PAGES) {
    const page = await context.newPage();
    await page.goto(url).catch(() => undefined);
  }
  console.log('Log in to each service with the DEDICATED eval accounts, then close the browser window.');
  console.log(`Profile: ${profileDir}`);
  await new Promise<void>((resolve) => context.on('close', () => resolve()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
