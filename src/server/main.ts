import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EncodeOptions } from '../encode.ts';
import { startServer } from './http.ts';
import { LoginManager } from './login-manager.ts';
import { Store } from './store.ts';

const DEFAULT_STORE_PATH = '.local/share/codebuddy-proxy/accounts.json';
const DEFAULT_SETTINGS_PATH = '.local/share/codebuddy-proxy/settings.json';

interface Settings {
  models: Record<string, string>;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: Settings = {
  models: {},
  systemPrompt: 'You are a helpful assistant.',
};

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function readSettings(filePath: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
  const raw = parsed as Record<string, unknown>;
  return {
    models: isStringRecord(raw['models']) ? raw['models'] : DEFAULT_SETTINGS.models,
    systemPrompt: typeof raw['systemPrompt'] === 'string' ? raw['systemPrompt'] : DEFAULT_SETTINGS.systemPrompt,
  };
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = positiveInt(env['CODEBUDDY_PROXY_PORT']) ?? 8787;
  const host = env['CODEBUDDY_PROXY_HOST'] ?? '127.0.0.1';
  const home = os.homedir();
  const storePath = env['CODEBUDDY_PROXY_STORE'] ?? path.join(home, DEFAULT_STORE_PATH);
  const encode: Omit<EncodeOptions, 'defaultModel'> = {
    ...readSettings(path.join(home, DEFAULT_SETTINGS_PATH)),
    cacheRetention: 'long',
    extraVars: { initiator: 'user' },
  };

  const store = await Store.load(storePath);
  const logins = new LoginManager(store);
  await logins.restore();
  await startServer({ host, port, encode }, store, logins);
  console.log(`codebuddy-proxy listening on http://${host}:${port}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  await main();
}
