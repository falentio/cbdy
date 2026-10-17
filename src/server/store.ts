import fs from 'node:fs';
import path from 'node:path';

import type { Credentials } from '../auth.ts';
import { jwtSubject, type Account, type LoginToken } from '../login.ts';

/** One managed account. `uid` is the account uid, which equals the JWT sub. */
export interface StoredAccount {
  uid: string;
  nickname: string;
  credentials: Credentials;
  addedAt: number;
}

export type StoredLogin =
  | { status: 'pending'; state: string; loginUrl: string; startedAt: number; deadlineAt: number }
  | { status: 'failed'; error: string; at: number };

interface PoolState {
  version: 1;
  activeUid: string | null;
  accounts: StoredAccount[];
  login: StoredLogin | null;
}

export interface AccountSummary {
  uid: string;
  nickname: string;
  addedAt: number;
  active: boolean;
}

const EMPTY_STATE: PoolState = { version: 1, activeUid: null, accounts: [], login: null };

function credentialsFrom(token: LoginToken, uid: string): Credentials {
  return {
    accessToken: token.accessToken,
    userId: uid,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
  };
}

async function persist(filePath: string, state: PoolState): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.promises.open(temporaryPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporaryPath, filePath);
}

export class Store {
  private state: PoolState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;

  private constructor(filePath: string, state: PoolState) {
    this.filePath = filePath;
    this.state = state;
  }

  static async load(filePath: string): Promise<Store> {
    let state = EMPTY_STATE;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as PoolState;
      if (parsed?.version === 1 && Array.isArray(parsed.accounts)) state = parsed;
    } catch {
    }
    return new Store(filePath, state);
  }

  accounts(): AccountSummary[] {
    return this.state.accounts.map((account) => ({
      uid: account.uid,
      nickname: account.nickname,
      addedAt: account.addedAt,
      active: account.uid === this.state.activeUid,
    }));
  }

  rotationCandidates(): { uid: string; credentials: Credentials }[] {
    const active = this.state.accounts.find((account) => account.uid === this.state.activeUid);
    const others = this.state.accounts.filter((account) => account !== active);
    const head = active === undefined ? [] : [{ uid: active.uid, credentials: active.credentials }];
    return [
      ...head,
      ...others.map((account) => ({ uid: account.uid, credentials: account.credentials })),
    ];
  }

  login(): StoredLogin | null {
    return this.state.login;
  }

  setLoginPending(state: string, loginUrl: string, deadlineAt: number, startedAt: number = Date.now()): Promise<void> {
    return this.mutate((pool) => ({
      ...pool,
      login: { status: 'pending', state, loginUrl, startedAt, deadlineAt },
    }));
  }

  setLoginFailed(error: string): Promise<void> {
    return this.mutate((pool) => ({ ...pool, login: { status: 'failed', error, at: Date.now() } }));
  }

  clearLogin(): Promise<void> {
    return this.mutate((pool) => ({ ...pool, login: null }));
  }

  completeLogin(account: Account, token: LoginToken): Promise<void> {
    return this.mutate((pool) => {
      const uid = jwtSubject(token.accessToken) ?? account.uid;
      const existing = pool.accounts.find((candidate) => candidate.uid === uid);
      const stored: StoredAccount = {
        uid,
        nickname: account.nickname,
        credentials: credentialsFrom(token, uid),
        addedAt: existing?.addedAt ?? Date.now(),
      };
      const accounts = existing
        ? pool.accounts.map((candidate) => (candidate.uid === uid ? stored : candidate))
        : [...pool.accounts, stored];
      return { ...pool, accounts, login: null, activeUid: pool.activeUid ?? uid };
    });
  }

  importAccount(account: { uid: string; nickname: string }, credentials: Credentials): Promise<void> {
    return this.mutate((pool) => {
      const existing = pool.accounts.find((candidate) => candidate.uid === account.uid);
      const stored: StoredAccount = {
        uid: account.uid,
        nickname: existing?.nickname ?? account.nickname,
        credentials,
        addedAt: existing?.addedAt ?? Date.now(),
      };
      const accounts = existing
        ? pool.accounts.map((candidate) => (candidate.uid === account.uid ? stored : candidate))
        : [...pool.accounts, stored];
      return { ...pool, accounts, activeUid: pool.activeUid ?? account.uid };
    });
  }

  async removeAccount(uid: string): Promise<boolean> {
    let removed = false;
    await this.mutate((pool) => {
      const accounts = pool.accounts.filter((candidate) => candidate.uid !== uid);
      removed = accounts.length !== pool.accounts.length;
      if (!removed) return pool;
      const activeUid = pool.activeUid === uid ? accounts[0]?.uid ?? null : pool.activeUid;
      return { ...pool, accounts, activeUid };
    });
    return removed;
  }

  async setActive(uid: string): Promise<boolean> {
    let found = false;
    await this.mutate((pool) => {
      if (!pool.accounts.some((candidate) => candidate.uid === uid)) return pool;
      found = true;
      return { ...pool, activeUid: uid };
    });
    return found;
  }

  private mutate(apply: (pool: PoolState) => PoolState): Promise<void> {
    const run = this.queue.then(async () => {
      const next = apply(this.state);
      await persist(this.filePath, next);
      this.state = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
