import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Credentials } from '../src/auth.ts';
import type { ChatOptions } from '../src/client.ts';
import { Rotator, type ChatImpl, type RotationCandidate } from '../src/server/rotate.ts';
import { Store } from '../src/server/store.ts';
import type { Account, LoginToken } from '../src/login.ts';
import type { OpenAiChatRequest, OpenAiChunk, OpenAiCompletion } from '../src/types.ts';

const REQUEST: OpenAiChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const OPTIONS: ChatOptions = { models: {}, defaultModel: 'm', systemPrompt: '' };

type Behavior = 'ok' | 'fail' | 'fail-after-chunk';

function fakeChat(responses: Record<string, Behavior[]>) {
  let plan = responses;
  const calls: string[] = [];
  const next = new Map<string, number>();
  const chunk: OpenAiChunk = {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  const completion: OpenAiCompletion = {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: null,
  };
  const take = (uid: string): { behavior: Behavior; n: number } => {
    const seen = next.get(uid) ?? 0;
    next.set(uid, seen + 1);
    return { behavior: plan[uid]?.[seen] ?? 'ok', n: seen + 1 };
  };
  const chat: ChatImpl = {
    async *streamChat(_request, options) {
      const uid = options.credentials?.userId ?? 'unknown';
      const { behavior, n } = take(uid);
      calls.push(`${uid}#${n}`);
      if (behavior !== 'fail') yield chunk;
      if (behavior !== 'ok') throw new Error(`${uid} attempt ${n} failed`);
    },
    async completeChat(_request, options) {
      const uid = options.credentials?.userId ?? 'unknown';
      const { behavior, n } = take(uid);
      calls.push(`${uid}#${n}`);
      if (behavior !== 'ok') throw new Error(`${uid} attempt ${n} failed`);
      return completion;
    },
  };
  return {
    chat,
    calls,
    replan(nextPlan: Record<string, Behavior[]>): void {
      for (const uid of new Set([...Object.keys(plan), ...Object.keys(nextPlan)])) next.delete(uid);
      plan = nextPlan;
      calls.length = 0;
    },
  };
}

function candidate(uid: string): RotationCandidate {
  const credentials: Credentials = { accessToken: `tok-${uid}`, userId: uid };
  return { uid, credentials };
}

function captureWarn(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => {
    lines.push(String(line));
  };
  return { lines, restore: () => { console.warn = original; } };
}

test('each account gets two attempts before the walk moves to the next', async () => {
  const fake = fakeChat({ a: ['fail', 'fail'], b: ['fail', 'fail'], c: ['fail', 'fail'] });
  const rotator = new Rotator(fake.chat);

  await assert.rejects(
    () => rotator.complete(REQUEST, [candidate('a'), candidate('b'), candidate('c')], OPTIONS),
    /c attempt 2 failed/,
  );

  assert.deepEqual(fake.calls, ['a#1', 'a#2', 'b#1', 'b#2', 'c#1', 'c#2']);
});

test('a success ends the walk and clears the penalty state', async () => {
  const fake = fakeChat({ a: ['fail', 'ok'] });
  const rotator = new Rotator(fake.chat);
  const completion = await rotator.complete(REQUEST, [candidate('a')], OPTIONS);
  assert.deepEqual(fake.calls, ['a#1', 'a#2']);
  assert.equal(completion.choices[0]?.message.content, 'hi');

  fake.replan({ a: ['fail', 'fail'], b: ['ok'] });
  await rotator.complete(REQUEST, [candidate('a'), candidate('b')], OPTIONS);
  assert.deepEqual(fake.calls, ['a#1', 'a#2', 'b#1']);
});

test('a cooled account sits out the next walk', async () => {
  const fake = fakeChat({ a: ['fail', 'fail'], b: ['ok'] });
  const rotator = new Rotator(fake.chat);
  const warn = captureWarn();
  try {
    await rotator.complete(REQUEST, [candidate('a'), candidate('b')], OPTIONS);
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0] ?? '', /account a/);
  assert.match(warn.lines[0] ?? '', /60s/);
  assert.match(warn.lines[0] ?? '', /a attempt 2 failed/);

  fake.replan({ a: ['ok'], b: ['ok'] });
  await rotator.complete(REQUEST, [candidate('a'), candidate('b')], OPTIONS);
  assert.deepEqual(fake.calls, ['b#1']);
});

test('when every account fails the last error propagates', async () => {
  const fake = fakeChat({ a: ['fail', 'fail'], b: ['fail', 'fail'] });
  const rotator = new Rotator(fake.chat);

  await assert.rejects(
    () => rotator.complete(REQUEST, [candidate('a'), candidate('b')], OPTIONS),
    /b attempt 2 failed/,
  );
});

test('a streaming failure after the first chunk propagates without retry', async () => {
  const fake = fakeChat({ a: ['fail-after-chunk'], b: ['ok'] });
  const rotator = new Rotator(fake.chat);
  const chunks: OpenAiChunk[] = [];

  await assert.rejects(async () => {
    for await (const chunk of rotator.stream(REQUEST, [candidate('a'), candidate('b')], OPTIONS)) {
      chunks.push(chunk);
    }
  }, /a attempt 1 failed/);

  assert.equal(chunks.length, 1);
  assert.deepEqual(fake.calls, ['a#1']);
});

test('the streaming walk retries a failure that happened before any chunk', async () => {
  const fake = fakeChat({ a: ['fail', 'ok'] });
  const rotator = new Rotator(fake.chat);
  const chunks: OpenAiChunk[] = [];

  for await (const chunk of rotator.stream(REQUEST, [candidate('a')], OPTIONS)) chunks.push(chunk);

  assert.deepEqual(fake.calls, ['a#1', 'a#2']);
  assert.equal(chunks.length, 1);
});

function tempStorePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cbproxy-rotate-')), 'accounts.json');
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

test('rotationCandidates orders the active account first, then stored order', async () => {
  const store = await Store.load(tempStorePath());
  assert.deepEqual(store.rotationCandidates(), []);

  await store.completeLogin(accountFor('u1'), tokenFor('u1'));
  await store.completeLogin(accountFor('u2'), tokenFor('u2'));
  await store.completeLogin(accountFor('u3'), tokenFor('u3'));
  await store.setActive('u2');

  const candidates = store.rotationCandidates();
  assert.deepEqual(
    candidates.map((entry) => entry.uid),
    ['u2', 'u1', 'u3'],
  );
  assert.equal(candidates[0]?.credentials.userId, 'u2');
});
