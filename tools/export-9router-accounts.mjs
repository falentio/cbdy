import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DB = path.join(os.homedir(), '.9router/db/data.sqlite');
const DEFAULT_OUTPUT = path.join(os.homedir(), '.local/share/codebuddy-proxy/9router-accounts.json');

const dbPath = process.argv[2] ?? DEFAULT_DB;
const outputPath = process.argv[3] ?? DEFAULT_OUTPUT;

const rows = JSON.parse(
  execFileSync('sqlite3', [
    `file:${dbPath}?mode=ro`,
    '-json',
    "SELECT id, name, data FROM providerConnections WHERE provider = 'codebuddy-intl'",
  ]).toString(),
);

const accounts = [];
for (const row of rows) {
  const data = JSON.parse(row.data);
  const accessToken = data.accessToken;
  if (typeof accessToken !== 'string' || accessToken === '') continue;
  const payload = accessToken.split('.')[1];
  if (payload === undefined) throw new Error(`connection ${row.id} has a malformed access token`);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new Error(`connection ${row.id} has no sub claim in its access token`);
  }
  const expiresAtMs = Date.parse(data.expiresAt);
  accounts.push({
    uid: claims.sub,
    nickname: typeof row.name === 'string' && row.name !== '' ? row.name : claims.sub,
    accessToken,
    refreshToken: data.refreshToken,
    ...(Number.isFinite(expiresAtMs) ? { expiresAt: expiresAtMs } : {}),
  });
}

const fileHandle = await fs.promises.open(outputPath, 'w', 0o600);
try {
  await fileHandle.writeFile(
    `${JSON.stringify({ version: 1, source: '9router', exportedAt: Date.now(), accounts }, null, 2)}\n`,
  );
  await fileHandle.sync();
} finally {
  await fileHandle.close();
}

console.log(`exported ${accounts.length} accounts from ${dbPath} to ${outputPath}`);
for (const account of accounts) {
  const expiry = account.expiresAt === undefined ? 'unknown' : new Date(account.expiresAt).toISOString().slice(0, 10);
  console.log(`  ${account.nickname}  uid=${account.uid.slice(0, 8)}…  expires ${expiry}`);
}
