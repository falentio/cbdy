import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialFilePath, readStoredCredentials } from '../src/auth.ts';
import { streamChat } from '../src/client.ts';
import { fetchAccounts, login, toStoredSession, writeStoredSession } from '../src/login.ts';
import type { LoginToken } from '../src/login.ts';

const captureFlag = process.argv.indexOf('--from-capture');
const capturePath = captureFlag === -1 ? undefined : process.argv[captureFlag + 1];

const home = mkdtempSync(join(tmpdir(), 'cbrev-login-'));
console.log(`temp home: ${home}`);

let token: LoginToken;
let filePath: string;

if (capturePath === undefined) {
  const result = await login({
    home,
    onLoginUrl: (url) => console.log(`open this and sign in: ${url}`),
  });
  token = result.session.auth;
  filePath = result.path;
  console.log(`signed in as ${result.session.account.nickname}`);
} else {
  const raw = fs.readFileSync(capturePath, 'utf8');
  token = JSON.parse(raw.slice(raw.indexOf('{'))).data as LoginToken;
  const accounts = await fetchAccounts(token);
  const account = accounts[0];
  if (account === undefined) throw new Error('captured token returned no accounts');
  filePath = await writeStoredSession(toStoredSession(token, account), home);
  console.log(`wrote a session from the capture for ${account.nickname}`);
}

console.log(`session file: ${filePath}`);
console.log(`matches credentialFilePath(home): ${filePath === credentialFilePath(home)}`);

const reloaded = readStoredCredentials(filePath);
if (reloaded === undefined) throw new Error('the file written by login was not readable');
if (reloaded.accessToken !== token.accessToken) throw new Error('the access token did not round-trip');
const subject = JSON.parse(Buffer.from(token.accessToken.split('.')[1]!, 'base64url').toString('utf8')).sub;
if (reloaded.userId !== subject) throw new Error(`user id mismatch: ${reloaded.userId} vs ${subject}`);
console.log(`reloaded user id: ${reloaded.userId}`);

let reply = '';
for await (const chunk of streamChat(
  { model: 'gpt-4o', messages: [{ role: 'user', content: 'Reply with exactly: LOGGEDIN' }] },
  {
    models: { 'gpt-4o': 'default-model' },
    defaultModel: 'default-model',
    systemPrompt: 'You are a helpful assistant.',
    credentials: reloaded,
  },
)) {
  const delta = chunk.choices[0]?.delta['content'];
  if (typeof delta === 'string') reply += delta;
}
console.log(`chat with the reloaded session: ${JSON.stringify(reply)}`);
if (reply !== 'LOGGEDIN') throw new Error(`unexpected completion: ${reply}`);
console.log('login smoke: OK');
