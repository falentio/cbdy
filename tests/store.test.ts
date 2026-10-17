import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Account, LoginToken } from '../src/login.ts';
import { Store } from '../src/server/store.ts';

function tempStorePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbproxy-store-')), 'accounts.json');
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

function accountFor(uid: string, nickname = uid): Account {
  return { uid, nickname, uin: uid, type: 'personal' };
}

async function reload(filePath: string): Promise<Store> {
  return Store.load(filePath);
}

test('concurrent mutations serialize and leave a consistent file', async () => {
  const filePath = tempStorePath();
  const store = await Store.load(filePath);
  await store.completeLogin(accountFor('u1'), tokenFor('u1'));
  await store.completeLogin(accountFor('u2'), tokenFor('u2'));

  await Promise.all([
    store.setLoginPending('state-1', 'https://login.example', Date.now() + 60_000),
    store.removeAccount('u1'),
    store.setActive('u2'),
  ]);

  const persisted = await reload(filePath);
  assert.deepEqual(persisted.accounts(), [
    { uid: 'u2', nickname: 'u2', addedAt: persisted.accounts()[0]?.addedAt, active: true },
  ]);
  assert.equal(persisted.login()?.status, 'pending');
  assert.equal(persisted.rotationCandidates()[0]?.uid, 'u2');
});

test('completeLogin persists account, cleared login, and active slot in one state', async () => {
  const filePath = tempStorePath();
  const store = await Store.load(filePath);
  await store.setLoginPending('state-1', 'https://login.example', Date.now() + 60_000);

  await store.completeLogin(accountFor('u1', 'Kevin'), tokenFor('u1'));

  const persisted = await reload(filePath);
  const accounts = persisted.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.uid, 'u1');
  assert.equal(accounts[0]?.active, true);
  assert.equal(persisted.login(), null);
  assert.equal(persisted.rotationCandidates()[0]?.credentials.accessToken, tokenFor('u1').accessToken);

  await store.completeLogin(accountFor('u1', 'Renamed'), tokenFor('u1'));
  const upserted = (await reload(filePath)).accounts();
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0]?.nickname, 'Renamed');
});

test('removing the active account falls back to the first remaining one', async () => {
  const filePath = tempStorePath();
  const store = await Store.load(filePath);
  await store.completeLogin(accountFor('u1'), tokenFor('u1'));
  await store.completeLogin(accountFor('u2'), tokenFor('u2'));
  await store.setActive('u1');

  assert.equal(await store.removeAccount('u1'), true);
  const afterRemove = await reload(filePath);
  assert.deepEqual(
    afterRemove.accounts().map((account) => account.uid),
    ['u2'],
  );
  assert.equal(afterRemove.accounts()[0]?.active, true);
  assert.equal(afterRemove.rotationCandidates()[0]?.uid, 'u2');

  assert.equal(await store.removeAccount('u2'), true);
  const emptied = await reload(filePath);
  assert.equal(emptied.accounts().length, 0);
  assert.deepEqual(emptied.rotationCandidates(), []);
});

test('removing an unknown account changes nothing', async () => {
  const filePath = tempStorePath();
  const store = await Store.load(filePath);
  await store.completeLogin(accountFor('u1'), tokenFor('u1'));
  assert.equal(await store.removeAccount('ghost'), false);
  assert.equal((await reload(filePath)).accounts().length, 1);
  assert.equal(await store.setActive('ghost'), false);
});

test('importAccount refreshes credentials but keeps the existing nickname', async () => {
  const filePath = tempStorePath();
  const store = await Store.load(filePath);
  await store.importAccount({ uid: 'u1', nickname: 'Kevin' }, {
    accessToken: 'old-token',
    userId: 'u1',
    refreshToken: 'old-refresh',
    expiresAt: 1_000,
  });

  await store.importAccount({ uid: 'u1', nickname: 'Account 1' }, {
    accessToken: 'new-token',
    userId: 'u1',
    refreshToken: 'new-refresh',
    expiresAt: 2_000,
  });

  const persisted = await reload(filePath);
  const accounts = persisted.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.nickname, 'Kevin');
  assert.equal(accounts[0]?.active, true);
  const credentials = persisted.rotationCandidates()[0]?.credentials;
  assert.equal(credentials?.accessToken, 'new-token');
  assert.equal(credentials?.refreshToken, 'new-refresh');
  assert.equal(credentials?.expiresAt, 2_000);
});

