import fs from 'node:fs';

const ENDPOINT = process.env.CODEBUDDY_ENDPOINT ?? 'https://www.codebuddy.ai';
const VERSION = process.env.CODEBUDDY_CLI_VERSION ?? '2.168.0';

const noAuth = {
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': `CLI/${VERSION} CodeBuddy/${VERSION}`,
  'x-product': 'SaaS',
  'x-ide-type': 'CLI',
  'x-ide-name': 'CLI',
  'x-ide-version': VERSION,
  'x-no-authorization': 'true',
  'x-no-user-id': 'true',
  'x-no-enterprise-id': 'true',
  'x-no-department-info': 'true',
};

const state = process.argv[2];
if (state) {
  const res = await fetch(`${ENDPOINT}/v2/plugin/auth/token?state=${state}`, { headers: noAuth });
  const text = await res.text();
  console.log(`GET /v2/plugin/auth/token?state=${state}`);
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')} ${text.length}B`);
  console.log(text.slice(0, 4000));
  if (process.env.TOKEN_OUT) fs.writeFileSync(process.env.TOKEN_OUT, text);
  process.exit(0);
}

const res = await fetch(`${ENDPOINT}/v2/plugin/auth/state?platform=CLI`, {
  method: 'POST',
  headers: noAuth,
  body: '{}',
});
const body = await res.json();
const authUrl = new URL(body.data.authUrl);
authUrl.searchParams.append('version', VERSION);
console.log(JSON.stringify(body));
console.log('');
console.log('STATE=' + body.data.state);
console.log('LOGIN_URL=' + authUrl.toString());
if (process.env.STATE_OUT) fs.writeFileSync(process.env.STATE_OUT, JSON.stringify(body));
