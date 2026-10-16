// Turns a live login poll response into a fixture set with tokens and identity replaced.
// usage: node tools/redact-login.mjs <saved-token-response.json> <fixtures-dir>
import fs from 'node:fs';
import path from 'node:path';

const [capturePath, fixturesDir] = process.argv.slice(2);
const raw = fs.readFileSync(capturePath, 'utf8');
const token = JSON.parse(raw.slice(raw.indexOf('{'))).data;

const fakeJwt = (claims) =>
  ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'REDACTED-SIGNATURE'].join('.');

const account = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'account.redacted.json'), 'utf8'));
const write = (name, body) => {
  fs.writeFileSync(path.join(fixturesDir, name), JSON.stringify(body, null, 2) + '\n');
};

write('login-token.json', {
  code: 0,
  msg: 'OK',
  requestId: 'redacted',
  data: {
    ...token,
    accessToken: fakeJwt({ sub: account.uid, iss: 'https://www.codebuddy.ai/auth/realms/copilot' }),
    refreshToken: fakeJwt({ sub: account.uid, typ: 'Offline' }),
    sessionState: '00000000-0000-0000-0000-000000000000',
  },
});
write('login-pending.json', { code: 11217, msg: '11217:login ing...', requestId: 'redacted' });
write('login-state.json', {
  code: 0,
  msg: 'OK',
  requestId: 'redacted',
  data: {
    state: '2c7f39cb-aa53-459f-acd6-46a52eb466c1',
    authUrl: 'https://www.codebuddy.ai/login?platform=CLI&state=2c7f39cb-aa53-459f-acd6-46a52eb466c1',
  },
});
write('login-accounts.json', { code: 0, msg: 'OK', requestId: 'redacted', data: { accounts: [account] } });
process.stdout.write('wrote 4 login fixtures\n');
