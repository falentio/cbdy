import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Credentials } from '../src/auth.ts';
import { Store } from '../src/server/store.ts';

const exportPath = process.argv[2];
const storePath = process.argv[3] ?? path.join(os.homedir(), '.local/share/codebuddy-proxy/accounts.json');

function fail(message: string): never {
  console.error(`${exportPath ?? '<missing path>'}: ${message}`);
  process.exit(1);
}

if (exportPath === undefined) {
  console.error('usage: node scripts/import-accounts.ts <export.json> [store.json]');
  process.exit(1);
}

interface ExportedAccount {
  uid: string;
  nickname: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
} catch (error) {
  fail(`not readable JSON (${error instanceof Error ? error.message : String(error)})`);
}
if (typeof parsed !== 'object' || parsed === null) fail('expected an object');
const { version, accounts } = parsed as { version?: unknown; accounts?: unknown };
if (version !== 1) fail(`unsupported export version ${JSON.stringify(version)}, expected 1`);
if (!Array.isArray(accounts)) fail('expected an accounts array');

const store = await Store.load(storePath);
let imported = 0;
for (const entry of accounts) {
  if (typeof entry !== 'object' || entry === null) fail('expected every account to be an object');
  const account = entry as Partial<ExportedAccount>;
  if (typeof account.uid !== 'string' || account.uid === '') {
    fail(`account ${imported} has no uid`);
  }
  if (typeof account.accessToken !== 'string' || account.accessToken === '') {
    fail(`account ${account.uid} has no accessToken`);
  }
  const credentials: Credentials = {
    accessToken: account.accessToken,
    userId: account.uid,
    ...(typeof account.refreshToken === 'string' && account.refreshToken !== ''
      ? { refreshToken: account.refreshToken }
      : {}),
    ...(typeof account.expiresAt === 'number' && Number.isFinite(account.expiresAt)
      ? { expiresAt: account.expiresAt }
      : {}),
  };
  const nickname = typeof account.nickname === 'string' && account.nickname !== '' ? account.nickname : account.uid;
  await store.importAccount({ uid: account.uid, nickname }, credentials);
  const expiry = account.expiresAt === undefined ? 'unknown' : new Date(account.expiresAt).toISOString().slice(0, 10);
  console.log(`imported ${nickname} (${account.uid.slice(0, 8)}…) expires ${expiry}`);
  imported += 1;
}

console.log(`${imported} account(s) into ${storePath}`);
