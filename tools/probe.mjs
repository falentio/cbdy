import fs from 'node:fs';

const capturePath = process.argv[2];
const bodyArg = process.argv[3];
if (!capturePath || !bodyArg) {
  console.error('usage: probe.mjs <captured-request.txt> <body.json|->');
  process.exit(2);
}

const endpoint =
  process.env.CODEBUDDY_ENDPOINT ?? 'https://www.codebuddy.ai/v2/chat/completions';

// PROBE_SET overrides headers as a JSON object; PROBE_UNSET drops a comma separated list.
const overrides = JSON.parse(process.env.PROBE_SET ?? '{}');
const dropped = new Set((process.env.PROBE_UNSET ?? '').split(',').filter(Boolean));

const HEADER_ALLOWLIST = new Set([
  'authorization', 'content-type', 'accept', 'user-agent', 'x-user-id', 'x-domain',
  'x-product', 'x-agent-purpose', 'x-agent-intent', 'x-agent-runtime', 'x-agent-type',
  'x-ide-type', 'x-ide-name', 'x-ide-version', 'x-private-data', 'x-codebuddy-request',
  'x-requested-with', 'x-conversation-id', 'x-conversation-message-id',
  'x-conversation-request-id', 'x-root-request-id', 'x-request-id',
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
for (const key of dropped) delete headers[key];
Object.assign(headers, overrides);

const bodyText =
  bodyArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(bodyArg, 'utf8');
const body = JSON.parse(bodyText);

const started = Date.now();
const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
const text = await res.text();
console.log(
  `HTTP ${res.status} ${res.headers.get('content-type')} in ${Date.now() - started}ms, ${text.length}B`,
);
if (process.env.PROBE_OUT) fs.writeFileSync(process.env.PROBE_OUT, text);
else process.stdout.write(text);

const lastFrame = text
  .split('\n')
  .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
  .at(-1);
if (lastFrame !== undefined) {
  const chunk = JSON.parse(lastFrame.slice(6));
  const usage = chunk.usage;
  console.log(
    `last chunk: finish_reason=${chunk.choices?.[0]?.finish_reason} usage=${usage === null || usage === undefined ? String(usage) : JSON.stringify(usage).slice(0, 240)}`,
  );
}
