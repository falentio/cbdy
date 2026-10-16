import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { credentialFilePath } from './auth.ts';
import { CodeBuddyRequestError, requestErrorFrom } from './errors.ts';
import type { CodeBuddyError } from './types.ts';

export interface LoginRequest {
  state: string;
  authUrl: string;
  loginUrl: string;
}

export interface LoginToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionState: string;
  scope: string;
  domain: string;
}

export interface Account {
  uid: string;
  nickname: string;
  uin: string;
  type: string;
  [key: string]: unknown;
}

export interface StoredSession {
  account: Account;
  auth: LoginToken & {
    lastRefreshTime: number;
    expiresAt: number;
    refreshExpiresAt: number;
  };
  accounts: Account[];
  allAccounts: Account[];
}

export type LoginPoll = { status: 'pending' } | { status: 'ready'; token: LoginToken };

export interface LoginOptions {
  baseUrl?: string;
  platform?: string;
  version?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  home?: string;
  onLoginUrl?: (loginUrl: string) => void;
}

const DEFAULT_BASE_URL = 'https://www.codebuddy.ai';
const DEFAULT_PLATFORM = 'CLI';
const DEFAULT_VERSION = '2.168.0';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 300_000;

// A still-open browser handshake is code 11217, "login ing...", not a failure:
// the gateway has no token to hand over yet.
const LOGIN_PENDING_CODE = 11217;

type LoginEnvelope<T> = CodeBuddyError & { data?: T };

export function loginHeaders(version: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': `CLI/${version} CodeBuddy/${version}`,
    'x-product': 'SaaS',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-no-authorization': 'true',
    'x-no-user-id': 'true',
    'x-no-enterprise-id': 'true',
    'x-no-department-info': 'true',
  };
}

export function accountHeaders(token: LoginToken, version: string): Record<string, string> {
  const userId = jwtSubject(token.accessToken);
  return {
    authorization: `Bearer ${token.accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': `CLI/${version} CodeBuddy/${version}`,
    'x-product': 'SaaS',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-domain': token.domain,
    ...(userId === undefined ? {} : { 'x-user-id': userId }),
  };
}

/** The access token is a Keycloak JWT whose sub claim is the account uid. */
export function jwtSubject(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

export async function requestLogin(options: LoginOptions = {}): Promise<LoginRequest> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const platform = options.platform ?? DEFAULT_PLATFORM;
  const version = options.version ?? DEFAULT_VERSION;
  const envelope = await pluginCall<{ state?: unknown; authUrl?: unknown }>(
    `${baseUrl}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`,
    { method: 'POST', headers: loginHeaders(version), body: '{}' },
  );
  if (envelope.code !== 0) throw new CodeBuddyRequestError(envelope);
  const state = envelope.data?.state;
  const authUrl = envelope.data?.authUrl;
  if (typeof state !== 'string' || typeof authUrl !== 'string') {
    throw new Error(`CodeBuddy login state carried no state or authUrl: ${JSON.stringify(envelope)}`);
  }
  return { state, authUrl, loginUrl: withVersion(authUrl, version) };
}

export async function pollLoginToken(state: string, options: LoginOptions = {}): Promise<LoginPoll> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const version = options.version ?? DEFAULT_VERSION;
  const envelope = await pluginCall<LoginToken>(
    `${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    { headers: loginHeaders(version) },
  );
  if (envelope.code === LOGIN_PENDING_CODE) return { status: 'pending' };
  if (envelope.code !== 0) throw new CodeBuddyRequestError(envelope);
  const token = envelope.data;
  if (token === undefined || typeof token.accessToken !== 'string' || token.accessToken === '') {
    throw new Error('CodeBuddy login answered code 0 without an access token');
  }
  return { status: 'ready', token };
}

export async function waitForLogin(state: string, options: LoginOptions = {}): Promise<LoginToken> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await pollLoginToken(state, options);
    if (poll.status === 'ready') return poll.token;
    await sleep(pollIntervalMs);
  }
  throw new Error(`CodeBuddy login timed out after ${timeoutMs} ms without a token for state ${state}`);
}

export async function fetchAccounts(
  token: LoginToken,
  options: LoginOptions = {},
): Promise<Account[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const version = options.version ?? DEFAULT_VERSION;
  const envelope = await pluginCall<{ accounts?: unknown }>(`${baseUrl}/v2/plugin/accounts`, {
    headers: accountHeaders(token, version),
  });
  if (envelope.code !== 0) throw new CodeBuddyRequestError(envelope);
  const accounts = envelope.data?.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error(`CodeBuddy accounts response carried no accounts list: ${JSON.stringify(envelope)}`);
  }
  return accounts as Account[];
}

export function toStoredSession(
  token: LoginToken,
  account: Account,
  now: number = Date.now(),
): StoredSession {
  return {
    account,
    auth: {
      ...token,
      lastRefreshTime: now,
      expiresAt: now + token.expiresIn * 1000,
      refreshExpiresAt: now + token.refreshExpiresIn * 1000,
    },
    accounts: [account],
    allAccounts: [account],
  };
}

export async function writeStoredSession(
  session: StoredSession,
  home: string = os.homedir(),
): Promise<string> {
  const filePath = credentialFilePath(home);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.promises.rename(temporaryPath, filePath);
  return filePath;
}

export async function login(
  options: LoginOptions = {},
): Promise<{ session: StoredSession; path: string }> {
  const request = await requestLogin(options);
  options.onLoginUrl?.(request.loginUrl);
  const token = await waitForLogin(request.state, options);
  const accounts = await fetchAccounts(token, options);
  const account = accounts[0];
  if (account === undefined) {
    throw new Error('CodeBuddy login returned an empty accounts list; no session was written.');
  }
  const session = toStoredSession(token, account);
  const filePath = await writeStoredSession(session, options.home);
  return { session, path: filePath };
}

async function pluginCall<T>(url: string, init: RequestInit): Promise<LoginEnvelope<T>> {
  const response = await fetch(url, init);
  const body = await response.text();
  const envelope = loginEnvelopeFrom<T>(body);
  if (!response.ok || envelope === undefined) throw requestErrorFrom(response.status, body);
  return envelope;
}

function loginEnvelopeFrom<T>(body: string): LoginEnvelope<T> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const code = (parsed as { code?: unknown }).code;
  if (typeof code !== 'number') return undefined;
  return parsed as LoginEnvelope<T>;
}

function withVersion(authUrl: string, version: string): string {
  const url = new URL(authUrl);
  url.searchParams.append('version', version);
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
