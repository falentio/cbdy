import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.CAPTURE_DIR ?? '/tmp/cbrev/capture';
const UPSTREAM = process.env.CAPTURE_UPSTREAM ?? 'https://www.codebuddy.ai';
const PORT = Number(process.env.CAPTURE_PORT ?? 8899);

fs.mkdirSync(OUT, { recursive: true });

let seq = 0;

http
  .createServer((req, res) => {
    const id = String(++seq).padStart(3, '0');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headerLines = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');
      fs.writeFileSync(
        path.join(OUT, `${id}-request.txt`),
        `${req.method} ${req.url}\n${headerLines}\n\n${body.toString('utf8')}`,
      );
      process.stdout.write(`capture ${id}: ${req.method} ${req.url} ${body.length}B\n`);

      const target = new URL(req.url, UPSTREAM);
      const up = https.request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: { ...req.headers, host: target.hostname, 'accept-encoding': 'identity' },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          const out = fs.createWriteStream(path.join(OUT, `${id}-response.txt`));
          upRes.on('data', (c) => {
            res.write(c);
            out.write(c);
          });
          upRes.on('end', () => {
            res.end();
            out.end();
          });
        },
      );
      up.on('error', (err) => {
        res.writeHead(502);
        res.end(String(err));
      });
      up.end(body);
    });
  })
  .listen(PORT, '127.0.0.1', () => process.stdout.write(`capture proxy -> ${UPSTREAM} on 127.0.0.1:${PORT}\n`));
