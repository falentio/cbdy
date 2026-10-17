import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodeBuddyRequestError } from '../src/errors.ts';
import type { LoginRequest, LoginToken } from '../src/login.ts';
import { LoginManager, type LoginManagerDeps } from '../src/server/login-manager.ts';
import { Store } from '../src/server/store.ts';

function tempStorePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbproxy-login-')), 'accounts.json');
}

function tokenFor(sub: string): LoginToken {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url');
  return {
    accessToken: `${payload}.fakesig`,
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    expiresIn: 3600,
    refreshExpiresIn: 3600,
    sessionState: 'session',
    scope: 'openid',
    domain: 'www.codebuddy.ai',
  };
}

const loginRequest: LoginRequest = {
  state: 'state-1',
  authUrl: 'https://auth.example',
  loginUrl: 'https://login.example',
};

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function manager(store: Store, deps: LoginManagerDeps = {}): LoginManager {
  return new LoginManager(store, { pollIntervalMs: 5, timeoutMs: 200, ...deps });
}

test('begin is idempotent while a login is pending', async () => {
  let requests = 0;
  const store = await Store.load(tempStorePath());
  const logins = manager(store, {
    requestLogin: async () => {
      requests++;
      return loginRequest;
    },
    pollLoginToken: async () => ({ status: 'pending' }),
  });

  const [first, second] = await Promise.all([logins.begin(), logins.begin()]);

  assert.equal(requests, 1);
  assert.equal(first.loginUrl, loginRequest.loginUrl);
  assert.equal(second.loginUrl, loginRequest.loginUrl);
  assert.equal(logins.status().status, 'pending');
  assert.equal(store.login()?.status, 'pending');
  await logins.cancel();
});

test('restore expires a stale pending login instead of resuming it', async () => {
  const store = await Store.load(tempStorePath());
  await store.setLoginPending('state-old', 'https://login.example', Date.now() + 300_000, Date.now() - 120_000);
  const logins = manager(store, { pollLoginToken: async () => ({ status: 'pending' }) });

  await logins.restore();

  assert.equal(logins.status().status, 'failed');
  const persisted = store.login();
  assert.ok(persisted !== null && persisted.status === 'failed');
  assert.equal(persisted.error, 'login timed out');
});

test('restore resumes a fresh pending login and polls it', async () => {
  const store = await Store.load(tempStorePath());
  await store.setLoginPending('state-1', 'https://login.example', Date.now() + 10_000, Date.now());
  let polls = 0;
  const logins = manager(store, {
    timeoutMs: 10_000,
    pollLoginToken: async () => {
      polls++;
      return { status: 'pending' };
    },
  });

  await logins.restore();

  assert.equal(logins.status().status, 'pending');
  await until(() => polls > 0, 'polls to start');
  await logins.cancel();
  assert.equal(store.login(), null);
});

test('transient poll errors retry until the deadline, then fail', async () => {
  let polls = 0;
  const store = await Store.load(tempStorePath());
  const logins = manager(store, {
    requestLogin: async () => loginRequest,
    pollLoginToken: async () => {
      polls++;
      throw new Error('ECONNRESET');
    },
  });

  await logins.begin();
  await until(() => store.login()?.status === 'failed', 'deadline failure');

  assert.ok(polls > 1, `expected retries, polled ${polls} times`);
  const persisted = store.login();
  assert.ok(persisted !== null && persisted.status === 'failed');
  assert.equal(persisted.error, 'login timed out');
});

test('a CodeBuddy error envelope is terminal and fails immediately', async () => {
  let polls = 0;
  const store = await Store.load(tempStorePath());
  const logins = manager(store, {
    requestLogin: async () => loginRequest,
    pollLoginToken: async () => {
      polls++;
      throw new CodeBuddyRequestError({ code: 400, msg: 'bad state' }, 400);
    },
  });

  await logins.begin();
  await until(() => store.login()?.status === 'failed', 'terminal failure');

  assert.equal(polls, 1);
  const persisted = store.login();
  assert.ok(persisted !== null && persisted.status === 'failed');
  assert.equal(persisted.error, 'CodeBuddy http 400 error 400: bad state');
});
