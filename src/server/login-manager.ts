import { CodeBuddyRequestError } from '../errors.ts';
import {
  fetchAccounts,
  pollLoginToken,
  requestLogin,
  type LoginOptions,
  type LoginToken,
} from '../login.ts';
import type { Store } from './store.ts';

export type LoginStatus =
  | { status: 'idle' }
  | { status: 'pending'; loginUrl: string }
  | { status: 'ready' }
  | { status: 'failed'; error: string };

export interface LoginManagerDeps extends LoginOptions {
  requestLogin?: typeof requestLogin;
  pollLoginToken?: typeof pollLoginToken;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const RESUME_MAX_AGE_MS = 60_000;

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LoginManager {
  private readonly store: Store;
  private readonly request: typeof requestLogin;
  private readonly poll: typeof pollLoginToken;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly loginOptions: LoginOptions;
  private statusValue: LoginStatus;
  private generation = 0;
  private beginning: Promise<{ loginUrl: string }> | undefined;

  constructor(store: Store, deps: LoginManagerDeps = {}) {
    this.store = store;
    this.request = deps.requestLogin ?? requestLogin;
    this.poll = deps.pollLoginToken ?? pollLoginToken;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.timeoutMs = deps.timeoutMs ?? 300_000;
    const { pollIntervalMs: _p, timeoutMs: _t, requestLogin: _r, pollLoginToken: _o, ...loginOptions } = deps;
    this.loginOptions = loginOptions;
    const stored = store.login();
    this.statusValue =
      stored === null
        ? { status: 'idle' }
        : stored.status === 'pending'
          ? { status: 'pending', loginUrl: stored.loginUrl }
          : { status: 'failed', error: stored.error };
  }

  async restore(): Promise<void> {
    const stored = this.store.login();
    if (stored === null || stored.status !== 'pending') return;
    const deadline = Math.min(stored.deadlineAt, stored.startedAt + RESUME_MAX_AGE_MS);
    if (Date.now() >= deadline) {
      this.statusValue = { status: 'failed', error: 'login timed out' };
      await this.store.setLoginFailed('login timed out');
      return;
    }
    this.run(stored.state, deadline, ++this.generation);
  }

  async begin(): Promise<{ loginUrl: string }> {
    if (this.statusValue.status === 'pending') return { loginUrl: this.statusValue.loginUrl };
    this.beginning ??= this.startBegin().finally(() => {
      this.beginning = undefined;
    });
    return this.beginning;
  }

  private async startBegin(): Promise<{ loginUrl: string }> {
    if (this.statusValue.status === 'pending') return { loginUrl: this.statusValue.loginUrl };
    const request = await this.request(this.loginOptions);
    const deadlineAt = Date.now() + this.timeoutMs;
    await this.store.setLoginPending(request.state, request.loginUrl, deadlineAt);
    this.statusValue = { status: 'pending', loginUrl: request.loginUrl };
    this.run(request.state, deadlineAt, ++this.generation);
    return { loginUrl: request.loginUrl };
  }

  async cancel(): Promise<void> {
    this.generation++;
    this.statusValue = { status: 'idle' };
    if (this.store.login() !== null) await this.store.clearLogin();
  }

  status(): LoginStatus {
    return this.statusValue;
  }

  private async run(state: string, deadlineAt: number, generation: number): Promise<void> {
    while (Date.now() < deadlineAt) {
      if (this.generation !== generation) return;
      try {
        const poll = await this.poll(state, this.loginOptions);
        if (poll.status === 'ready') {
          if (this.generation !== generation) return;
          await this.finish(poll.token);
          return;
        }
      } catch (error) {
        if (this.generation !== generation) return;
        if (error instanceof CodeBuddyRequestError) {
          await this.fail(messageFrom(error));
          return;
        }
      }
      if (this.generation !== generation) return;
      await LoginManager.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadlineAt - Date.now())));
    }
    if (this.generation === generation) await this.fail('login timed out');
  }

  private async finish(token: LoginToken): Promise<void> {
    this.statusValue = { status: 'ready' };
    try {
      const accounts = await fetchAccounts(token);
      const account = accounts[0];
      if (account === undefined) throw new Error('CodeBuddy returned an empty accounts list');
      await this.store.completeLogin(account, token);
      this.statusValue = { status: 'idle' };
    } catch (error) {
      await this.fail(messageFrom(error));
    }
  }

  private async fail(error: string): Promise<void> {
    this.statusValue = { status: 'failed', error };
    await this.store.setLoginFailed(error);
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
