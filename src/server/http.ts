import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { completeChat, streamChat } from '../client.ts';
import type { EncodeOptions } from '../encode.ts';
import { CodeBuddyRequestError } from '../errors.ts';
import type { OpenAiChatRequest, OpenAiChunk } from '../types.ts';
import type { LoginManager } from './login-manager.ts';
import type { StoredLogin, Store } from './store.ts';

export interface ServerConfig {
  host: string;
  port: number;
  encode: Omit<EncodeOptions, 'defaultModel'>;
}

const BODY_LIMIT_BYTES = 32 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (req: http.IncomingMessage, res: http.ServerResponse, params: string[]) => Promise<void>;
}

function publicLogin(login: StoredLogin | null): Record<string, unknown> | null {
  if (login === null) return null;
  if (login.status === 'pending') {
    return {
      status: 'pending',
      loginUrl: login.loginUrl,
      startedAt: login.startedAt,
      deadlineAt: login.deadlineAt,
    };
  }
  return { status: 'failed', error: login.error, at: login.at };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorTypeFor(status: number): string {
  if (status === 502) return 'upstream_error';
  if (status === 500) return 'internal_error';
  return 'invalid_request_error';
}

function sendError(res: http.ServerResponse, status: number, message: string, code?: number): void {
  json(res, status, { error: { message, type: errorTypeFor(status), code: code ?? status } });
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, `request body exceeds the ${limit} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseChatRequest(body: string): OpenAiChatRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw['model'] !== 'string' || raw['model'] === '') {
    throw new HttpError(400, 'model must be a non-empty string');
  }
  if (!Array.isArray(raw['messages']) || raw['messages'].length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array');
  }
  for (const message of raw['messages']) {
    if (typeof message !== 'object' || message === null) {
      throw new HttpError(400, 'each message must be an object');
    }
    const entry = message as Record<string, unknown>;
    if (typeof entry['role'] !== 'string') throw new HttpError(400, 'each message needs a role');
    const content = entry['content'];
    if (content !== null && typeof content !== 'string' && !Array.isArray(content)) {
      throw new HttpError(400, 'message content must be a string, an array, or null');
    }
  }
  return raw as unknown as OpenAiChatRequest;
}

async function writeSse(
  res: http.ServerResponse,
  chunks: AsyncGenerator<OpenAiChunk>,
): Promise<void> {
  for await (const chunk of chunks) {
    if (res.destroyed) return;
    const frame = `data: ${JSON.stringify(chunk)}\n\n`;
    if (!res.write(frame) && !res.destroyed) await once(res, 'drain');
  }
  if (!res.destroyed) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function buildRoutes(config: ServerConfig, store: Store, logins: LoginManager): Route[] {
  const chatOptions = (request: OpenAiChatRequest) => {
    const credentials = store.activeCredentials();
    if (credentials === undefined) throw new HttpError(409, 'no active account');
    return { ...config.encode, defaultModel: request.model, credentials };
  };

  const infer = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req, BODY_LIMIT_BYTES);
    const request = parseChatRequest(body);
    const options = chatOptions(request);
    if (request.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      await writeSse(res, streamChat(request, options));
      return;
    }
    json(res, 200, await completeChat(request, options));
  };

  const accountParam = (value: string | undefined): string => {
    if (value === undefined || value === '') throw new HttpError(404, 'unknown route');
    return decodeURIComponent(value);
  };

  return [
    {
      method: 'POST',
      pattern: /^\/v1\/chat\/completions$/,
      handle: infer,
    },
    {
      method: 'GET',
      pattern: /^\/api\/accounts$/,
      handle: async (_req, res) => {
        json(res, 200, { accounts: store.accounts(), login: publicLogin(store.login()) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/accounts\/login$/,
      handle: async (_req, res) => {
        const { loginUrl } = await logins.begin();
        json(res, 200, { status: 'pending', loginUrl });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/accounts\/login$/,
      handle: async (_req, res) => {
        await logins.cancel();
        json(res, 200, { ok: true });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/accounts\/([^/]+)$/,
      handle: async (_req, res, params) => {
        if (!(await store.removeAccount(accountParam(params[0])))) {
          throw new HttpError(404, `no account ${params[0]}`);
        }
        json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/accounts\/([^/]+)\/active$/,
      handle: async (_req, res, params) => {
        if (!(await store.setActive(accountParam(params[0])))) {
          throw new HttpError(404, `no account ${params[0]}`);
        }
        json(res, 200, { ok: true });
      },
    },
  ];
}

export async function startServer(
  config: ServerConfig,
  store: Store,
  logins: LoginManager,
): Promise<{ close(): Promise<void> }> {
  const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');
  const [page, routes] = await Promise.all([
    fs.promises.readFile(pagePath, 'utf8'),
    Promise.resolve(buildRoutes(config, store, logins)),
  ]);

  const server = http.createServer((req, res) => {
    void serve(req, res, routes, page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function serve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: Route[],
  page: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (req.method === route.method && match !== null) {
        await route.handle(req, res, match.slice(1));
        return;
      }
    }
    throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message);
    } else if (error instanceof CodeBuddyRequestError) {
      sendError(res, 502, error.message, error.code);
    } else {
      sendError(res, 500, `internal error: ${messageFrom(error)}`);
    }
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
