// Regenerates fixtures/ from a raw capture without leaking credentials or user text.
// usage: node tools/redact-capture.mjs <capture-dir> <fixtures-dir>
import fs from 'node:fs';
import path from 'node:path';

const [captureDir, fixturesDir] = process.argv.slice(2);
fs.mkdirSync(fixturesDir, { recursive: true });

const SECRET_HEADERS = /^(authorization|cookie|set-cookie)$/i;
const ID_HEADERS = /-id$|^traceparent$|^b3$|^baggage$|^x-b3-|^x-trace-id$/i;

function parseCapture(text) {
  const [head, ...rest] = text.split('\n\n');
  const [requestLine, ...headerLines] = head.split('\n');
  const headers = {};
  for (const line of headerLines) {
    const sep = line.indexOf(': ');
    if (sep > 0) headers[line.slice(0, sep).toLowerCase()] = line.slice(sep + 2);
  }
  return { requestLine, headers, body: rest.join('\n\n') };
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  if (typeof value === 'string') {
    if (value.length > 400) return `${value.slice(0, 120)}<TRUNCATED ${value.length} chars>`;
    return value
      .replace(/<user_query>[\s\S]*?<\/user_query>/g, '<user_query>Reply with exactly: PONG</user_query>')
      .replace(/[0-9a-f]{32,}/gi, 'REDACTED-ID')
      .replace(/\/home\/[^\s"']+/g, '/home/example');
  }
  return value;
}

for (const file of fs.readdirSync(captureDir).filter((f) => f.endsWith('-request.txt'))) {
  const parsed = parseCapture(fs.readFileSync(path.join(captureDir, file), 'utf8'));
  const headers = {};
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (SECRET_HEADERS.test(k)) headers[k] = 'REDACTED';
    else if (ID_HEADERS.test(k)) headers[k] = 'REDACTED-ID';
    else headers[k] = v;
  }
  const stem = file.replace('-request.txt', '');
  fs.writeFileSync(
    path.join(fixturesDir, `${stem}-request.json`),
    JSON.stringify({ requestLine: parsed.requestLine, headers, body: scrub(JSON.parse(parsed.body)) }, null, 2),
  );
  const responsePath = path.join(captureDir, file.replace('-request.txt', '-response.txt'));
  if (fs.existsSync(responsePath)) {
    fs.copyFileSync(responsePath, path.join(fixturesDir, `${stem}-response.sse`));
  }
}
process.stdout.write(`redacted ${fs.readdirSync(fixturesDir).length} fixture files\n`);
