// Turns a live login capture into a fixture with the tokens and identity replaced.
// usage: node tools/redact-login.mjs <login-result.txt> <fixtures-dir>
import fs from 'node:fs';
import path from 'node:path';

const [capturePath, fixturesDir] = process.argv.slice(2);
const raw = fs.readFileSync(capturePath, 'utf8');
const payload = JSON.parse(raw.slice(raw.indexOf('{')));

const fakeJwt = (claims) =>
  ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'REDACTED-SIGNATURE'].join('.');

const token = payload.data;
const account = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, '..', '.audit', 'account.json'), 'utf8'),
);

const redactedToken = {
  ...token,
  accessToken: fakeJwt({ sub: '00000000-0000-0000-0000-000000000000', iss: 'https://www.codebuddy.ai/auth/realms/copilot' }),
  refreshToken: fakeJwt({ sub: '00000000-0000-0000-0000-000000000000', typ: 'Offline' }),
  sessionState: '00000000-0000-0000-0000-000000000000',
};

fs.mkdirSync(fixturesDir, { recursive: true });
fs.writeFileSync(
  path.join(fixturesDir, 'login-token.json'),
  JSON.stringify({ code: 0, msg: 'OK', requestId: 'redacted', data: redactedToken }, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(fixturesDir, 'login-pending.json'),
  JSON.stringify({ code: 11217, msg: '11217:login ing...', requestId: 'redacted' }, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(fixturesDir, 'login-state.json'),
  JSON.stringify(
    {
      code: 0,
      msg: 'OK',
      requestId: 'redacted',
      data: {
        state: '2c7f39cb-aa53-459f-acd6-46a52eb466c1',
        authUrl: 'https://www.codebuddy.ai/login?platform=CLI&state=2c7f39cb-aa53-459f-acd6-46a52eb466c1',
      },
    },
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(
  path.join(fixturesDir, 'login-accounts.json'),
  JSON.stringify({ code: 0, msg: 'OK', requestId: 'redacted', data: { accounts: [account] } }, null, 2) + '\n',
);
process.stdout.write('wrote 4 login fixtures\n');
