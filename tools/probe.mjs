import fs from 'node:fs';

const capturePath = process.argv[2];
const bodyArg = process.argv[3];
if (!capturePath || !bodyArg) {
  console.error('usage: probe.mjs <captured-request.txt> <body.json|->');
  process.exit(2);
}

const endpoint =
  process.env.CODEBUDDY_ENDPOINT ?? 'https://www.codebuddy.ai/v2/chat/completions';

const HEADER_ALLOWLIST = new Set([
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'x-user-id',
  'x-domain',
  'x-product',
  'x-agent-purpose',
  'x-agent-intent',
  'x-agent-runtime',
  'x-agent-type',
  'x-ide-type',
  'x-ide-name',
  'x-ide-version',
  'x-private-data',
  'x-codebuddy-request',
  'x-requested-with',
  'x-conversation-id',
  'x-conversation-message-id',
  'x-conversation-request-id',
  'x-root-request-id',
]);

function headersFromCapture(text) {
  const headerBlock = text.split('\n\n')[0].split('\n').slice(1);
  const out = {};
  for (const line of headerBlock) {
    const sep = line.indexOf(': ');
    if (sep < 0) continue;
    const key = line.slice(0, sep).toLowerCase();
    if (HEADER_ALLOWLIST.has(key)) out[key] = line.slice(sep + 2);
  }
  return out;
}

const captured = fs.readFileSync(capturePath, 'utf8');
const headers = headersFromCapture(captured);
if (!headers.authorization) throw new Error('no authorization header in capture');

const bodyText =
  bodyArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(bodyArg, 'utf8');
const body = JSON.parse(bodyText);

const started = Date.now();
const res = await fetch(endpoint, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});

console.log(`HTTP ${res.status} ${res.headers.get('content-type')} in ${Date.now() - started}ms`);
process.stdout.write(await res.text());
