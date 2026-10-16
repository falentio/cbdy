import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { credentialFilePath, readStoredCredentials } from '../src/auth.ts';
import { CodeBuddyRequestError } from '../src/errors.ts';
import {
  accountHeaders,
  login,
  pollLoginToken,
  requestLogin,
  toStoredSession,
  waitForLogin,
  writeStoredSession,
} from '../src/login.ts';
import type { Account, LoginToken } from '../src/login.ts';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

function withFetch(
  respond: (call: FetchCall) => { status?: number; body: unknown },
  run: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const headersOf = (call: FetchCall | undefined): Record<string, string> =>
  (call?.init.headers ?? {}) as Record<string, string>;

const stateFixture = (): { code: number; data: { state: string; authUrl: string } } =>
  fixture('login-state.json');

const tokenFixture = (): { code: number; data: LoginToken } => fixture('login-token.json');

const accountsFixture = (): { code: number; data: { accounts: Account[] } } =>
  fixture('login-accounts.json');

const pendingFixture = (): { code: number; msg: string } => fixture('login-pending.json');

function accountFixture(): Account {
  const account = accountsFixture().data.accounts[0];
  assert.ok(account);
  return account;
}

function sessionFixture(): ReturnType<typeof toStoredSession> {
  return toStoredSession(tokenFixture().data, accountFixture(), 1_700_000_000_000);
}

test('requestLogin asks for a state and appends the version to the login url', async () => {
  const state = stateFixture();
  await withFetch(
    () => ({ body: state }),
    async (calls) => {
      const request = await requestLogin({ baseUrl: 'https://example.test' });

      assert.equal(calls[0]?.url, 'https://example.test/v2/plugin/auth/state?platform=CLI');
      assert.equal(calls[0]?.init.method, 'POST');
      assert.equal(calls[0]?.init.body, '{}');

      const headers = headersOf(calls[0]);
      for (const name of [
        'x-no-authorization',
        'x-no-user-id',
        'x-no-enterprise-id',
        'x-no-department-info',
      ]) {
        assert.equal(headers[name], 'true', name);
      }
      assert.equal(headers['user-agent'], 'CLI/2.168.0 CodeBuddy/2.168.0');
      assert.equal(headers['x-product'], 'SaaS');
      assert.equal(headers.accept, 'application/json');

      assert.equal(request.state, state.data.state);
      assert.equal(request.authUrl, state.data.authUrl);
      const loginUrl = new URL(request.loginUrl);
      assert.equal(loginUrl.searchParams.get('version'), '2.168.0');
      assert.equal(loginUrl.searchParams.get('state'), state.data.state);
      assert.equal(loginUrl.searchParams.get('platform'), 'CLI');
    },
  );
});

test('requestLogin honours the version and platform overrides', async () => {
  await withFetch(
    () => ({ body: stateFixture() }),
    async (calls) => {
      const request = await requestLogin({ platform: 'VSCode', version: '9.9.9' });
      assert.equal(calls[0]?.url, 'https://www.codebuddy.ai/v2/plugin/auth/state?platform=VSCode');
      assert.equal(headersOf(calls[0])['user-agent'], 'CLI/9.9.9 CodeBuddy/9.9.9');
      assert.equal(new URL(request.loginUrl).searchParams.get('version'), '9.9.9');
    },
  );
});

test('pollLoginToken reads the pending code as a waiting login', async () => {
  await withFetch(
    () => ({ body: pendingFixture() }),
    async (calls) => {
      const poll = await pollLoginToken('state-1', { baseUrl: 'https://example.test' });
      assert.deepEqual(poll, { status: 'pending' });
      assert.equal(calls[0]?.url, 'https://example.test/v2/plugin/auth/token?state=state-1');
      assert.equal(calls[0]?.init.method ?? 'GET', 'GET');
    },
  );
});

test('pollLoginToken returns the token the gateway handed over', async () => {
  const ready = tokenFixture();
  await withFetch(
    () => ({ body: ready }),
    async () => {
      const poll = await pollLoginToken('state-1');
      assert.equal(poll.status, 'ready');
      if (poll.status !== 'ready') assert.fail('expected a ready poll');
      assert.deepEqual(poll.token, ready.data);
    },
  );
});

test('pollLoginToken throws the envelope for an unexpected code', async () => {
  await withFetch(
    () => ({ body: { code: 40001, msg: 'not logged in', requestId: 'req-1' } }),
    async () => {
      await assert.rejects(
        pollLoginToken('state-1'),
        (error: unknown) =>
          error instanceof CodeBuddyRequestError &&
          error.code === 40001 &&
          error.envelope.msg === 'not logged in',
      );
    },
  );
});

test('a code 0 answer with no access token is not a ready login', async () => {
  await withFetch(
    () => ({ body: { code: 0, msg: 'OK', data: { refreshToken: 'only-a-refresh' } } }),
    async () => {
      await assert.rejects(
        pollLoginToken('state-1'),
        (error: unknown) => error instanceof Error && /without an access token/.test(error.message),
      );
    },
  );
});

test('an http failure carries the envelope and its status', async () => {
  await withFetch(
    () => ({ status: 401, body: { code: 10401, msg: 'unauthorized' } }),
    async () => {
      await assert.rejects(
        requestLogin(),
        (error: unknown) =>
          error instanceof CodeBuddyRequestError && error.code === 10401 && error.status === 401,
      );
    },
  );
});

test('accountHeaders carries the bearer, the subject and the domain', () => {
  const token = tokenFixture().data;
  const headers = accountHeaders(token, '2.168.0');
  const claims = JSON.parse(
    Buffer.from(token.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { sub: string };

  assert.equal(headers.authorization, `Bearer ${token.accessToken}`);
  assert.equal(headers['x-user-id'], claims.sub);
  assert.equal(headers['x-domain'], 'www.codebuddy.ai');
  assert.equal(headers['user-agent'], 'CLI/2.168.0 CodeBuddy/2.168.0');
  assert.equal(headers['x-no-authorization'], undefined);
});

test('toStoredSession counts the expiry in seconds from the supplied clock', () => {
  const token = tokenFixture().data;
  const account = accountFixture();
  const now = 1_700_000_000_000;

  const session = toStoredSession(token, account, now);

  assert.equal(session.auth.lastRefreshTime, now);
  assert.equal(session.auth.expiresAt, now + token.expiresIn * 1000);
  assert.equal(session.auth.refreshExpiresAt, now + token.refreshExpiresIn * 1000);
  assert.equal(session.account, account);
  assert.deepEqual(session.accounts, [account]);
  assert.deepEqual(session.allAccounts, [account]);
  assert.equal(session.auth.accessToken, token.accessToken);
  assert.equal(session.auth.sessionState, token.sessionState);
});

test('writeStoredSession writes a session the auth store reads back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbrev-login-'));
  try {
    const session = sessionFixture();
    const written = await writeStoredSession(session, dir);

    assert.equal(written, credentialFilePath(dir));
    assert.equal(statSync(written).mode & 0o777, 0o600);

    const credentials = readStoredCredentials(written);
    assert.equal(credentials?.accessToken, session.auth.accessToken);
    assert.equal(credentials?.refreshToken, session.auth.refreshToken);
    assert.equal(credentials?.userId, session.account.uid);
    assert.equal(credentials?.expiresAt, session.auth.expiresAt);

    const onDisk = JSON.parse(readFileSync(written, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(onDisk).sort(), ['account', 'accounts', 'allAccounts', 'auth']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForLogin returns the token once a poll is ready', async () => {
  const ready = tokenFixture();
  const responses: unknown[] = [pendingFixture(), ready];
  await withFetch(
    () => ({ body: responses.shift() ?? pendingFixture() }),
    async (calls) => {
      const token = await waitForLogin('state-1', { pollIntervalMs: 1, timeoutMs: 5000 });
      assert.deepEqual(token, ready.data);
      assert.equal(calls.length, 2);
    },
  );
});

test('waitForLogin gives up when the budget runs out', async () => {
  await withFetch(
    () => ({ body: pendingFixture() }),
    async (calls) => {
      await assert.rejects(
        waitForLogin('state-1', { pollIntervalMs: 1, timeoutMs: 50 }),
        (error: unknown) => error instanceof Error && /timed out after 50 ms/.test(error.message),
      );
      assert.ok(calls.length > 1, 'polled more than once before giving up');
    },
  );
});

test('login walks the handshake and writes the session', async () => {
  const state = stateFixture();
  const ready = tokenFixture();
  const accounts = accountsFixture();
  const responses: unknown[] = [state, pendingFixture(), ready, accounts];
  const dir = mkdtempSync(join(tmpdir(), 'cbrev-login-'));
  let announced: string | undefined;
  try {
    await withFetch(
      () => ({ body: responses.shift() ?? pendingFixture() }),
      async (calls) => {
        const result = await login({
          home: dir,
          pollIntervalMs: 1,
          timeoutMs: 5000,
          onLoginUrl: (url) => {
            announced = url;
          },
        });

        assert.equal(calls.length, 4);
        assert.equal(calls[0]?.url, 'https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI');
        assert.equal(calls[3]?.url, 'https://www.codebuddy.ai/v2/plugin/accounts');
        assert.equal(headersOf(calls[3]).authorization, `Bearer ${ready.data.accessToken}`);

        assert.equal(announced, new URL(state.data.authUrl + '&version=2.168.0').toString());
        assert.equal(result.path, credentialFilePath(dir));
        assert.equal(result.session.account.uid, accountFixture().uid);
        assert.equal(result.session.auth.expiresIn, ready.data.expiresIn);

        const credentials = readStoredCredentials(result.path);
        assert.equal(credentials?.accessToken, ready.data.accessToken);
        assert.equal(credentials?.userId, accountFixture().uid);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('login refuses to write when no account came back', async () => {
  const responses: unknown[] = [
    stateFixture(),
    tokenFixture(),
    { code: 0, msg: 'OK', data: { accounts: [] } },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'cbrev-login-'));
  try {
    await withFetch(
      () => ({ body: responses.shift() ?? pendingFixture() }),
      async () => {
        await assert.rejects(
          login({ home: dir, pollIntervalMs: 1, timeoutMs: 5000 }),
          (error: unknown) =>
            error instanceof Error && /empty accounts list/.test(error.message),
        );
        assert.equal(existsSync(credentialFilePath(dir)), false);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
