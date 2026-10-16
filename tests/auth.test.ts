import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CredentialsUnavailableError,
  anonymousUserId,
  readStoredCredentials,
  resolveCredentials,
  userIdFromJwt,
} from '../src/auth.ts';

const jwtWithSub = (sub: string): string =>
  [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub })).toString('base64url'),
    'signature',
  ].join('.');

function withStore(contents: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cbrev-auth-'));
  const path = join(dir, 'Tencent-Cloud.coding-copilot.info');
  writeFileSync(path, JSON.stringify(contents));
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reads the account uid and tokens from the stored session', () => {
  withStore(
    {
      account: { uid: 'account-uid', nickname: 'someone' },
      auth: { accessToken: jwtWithSub('jwt-sub'), refreshToken: 'refresh', expiresAt: 1 },
      accounts: [],
    },
    (path) => {
      const credentials = readStoredCredentials(path);
      assert.equal(credentials?.userId, 'account-uid');
      assert.equal(credentials?.accessToken, jwtWithSub('jwt-sub'));
      assert.equal(credentials?.refreshToken, 'refresh');
    },
  );
});

test('falls back to the token subject when the store has no uid', () => {
  withStore({ account: {}, auth: { accessToken: jwtWithSub('from-subject') }, accounts: [] }, (path) => {
    assert.equal(readStoredCredentials(path)?.userId, 'from-subject');
  });
});

test('an env token wins over the store and keeps the stored user id', () => {
  withStore(
    { account: { uid: 'account-uid' }, auth: { accessToken: jwtWithSub('stale') }, accounts: [] },
    (path) => {
      const credentials = resolveCredentials({ CODEBUDDY_AUTH_TOKEN: 'Bearer fresh' }, path);
      assert.equal(credentials.accessToken, 'fresh');
      assert.equal(credentials.userId, 'account-uid');
    },
  );
});

test('a non JWT env key with no store gets the anonymous user id', () => {
  const credentials = resolveCredentials(
    { CODEBUDDY_API_KEY: 'ck_1234567890' },
    '/nonexistent/path.info',
  );
  assert.equal(credentials.accessToken, 'ck_1234567890');
  assert.equal(credentials.userId, anonymousUserId('ck_1234567890'));
});

test('no token anywhere is an unavailability, not a crash', () => {
  assert.throws(
    () => resolveCredentials({}, '/nonexistent/path.info'),
    (error: unknown) =>
      error instanceof CredentialsUnavailableError && /CODEBUDDY_AUTH_TOKEN/.test(error.message),
  );
});

test('userIdFromJwt survives a token that is not a JWT', () => {
  assert.equal(userIdFromJwt('not.a.jwt'), undefined);
  assert.equal(userIdFromJwt('ck_abc'), undefined);
});
