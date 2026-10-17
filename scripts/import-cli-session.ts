import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { credentialFilePath, readStoredCredentials } from '../src/auth.ts';
import { Store } from '../src/server/store.ts';

const sessionPath = process.argv[2] ?? credentialFilePath();
const storePath = process.argv[3] ?? path.join(os.homedir(), '.local/share/codebuddy-proxy/accounts.json');

const credentials = readStoredCredentials(sessionPath);
if (credentials === undefined) {
  console.error(`no stored CodeBuddy session at ${sessionPath}; run 'codebuddy' once to sign in first`);
  process.exit(1);
}

const stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as {
  account?: { uid?: string; nickname?: string };
};
const uid = stored.account?.uid ?? credentials.userId;
const nickname = stored.account?.nickname ?? uid;

const store = await Store.load(storePath);
await store.importAccount({ uid, nickname }, credentials);

console.log(`imported account ${nickname} (${uid}) from ${sessionPath}`);
console.log(`wrote ${storePath} and set it active`);
