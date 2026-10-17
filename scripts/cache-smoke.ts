import assert from 'node:assert/strict';
import { streamChat } from '../src/client.ts';
import type { EncodeOptions } from '../src/encode.ts';
import type { OpenAiChatRequest, OpenAiUsage } from '../src/types.ts';

const MODEL = 'deepseek-v4.1-flash';
const SENTENCE = 'The quick brown fox jumps over the lazy dog while the cache entry is written to disk. ';

const UNIQUE_PROMPT = `Cache probe ${crypto.randomUUID().slice(0, 8)}. ${SENTENCE.repeat(16)}`;

const options: EncodeOptions = {
  models: { [MODEL]: MODEL },
  defaultModel: MODEL,
  systemPrompt: UNIQUE_PROMPT,
  cacheRetention: 'long',
  extraVars: { initiator: 'user' },
};

const request: OpenAiChatRequest = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
};

function cacheCounts(usage: OpenAiUsage, label: string): { prompt: number; hit: number; miss: number } {
  const { prompt_tokens: prompt, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss } = usage;
  const observed = JSON.stringify(usage);
  assert(prompt !== undefined, `${label}: usage had no prompt_tokens, observed ${observed}`);
  assert(hit !== undefined, `${label}: usage had no prompt_cache_hit_tokens, observed ${observed}`);
  assert(miss !== undefined, `${label}: usage had no prompt_cache_miss_tokens, observed ${observed}`);
  return { prompt, hit, miss };
}

async function runOnce(label: string): Promise<OpenAiUsage> {
  const started = Date.now();
  const pieces: string[] = [];
  let usage: OpenAiUsage | undefined;
  for await (const chunk of streamChat(request, options)) {
    const delta = chunk.choices[0]?.delta['content'];
    if (typeof delta === 'string') pieces.push(delta);
    if (chunk.usage) usage = chunk.usage;
  }
  const elapsedMs = Date.now() - started;
  assert(usage, `${label}: stream ended with no usage chunk`);
  console.log(`${label} ${elapsedMs}ms text=${JSON.stringify(pieces.join(''))}`);
  console.log(`${label} usage ${JSON.stringify(usage)}`);
  return usage;
}

const first = cacheCounts(await runOnce('run1'), 'run1');
const second = cacheCounts(await runOnce('run2'), 'run2');

assert(first.hit === 0, `run1 prompt_cache_hit_tokens was ${first.hit}, expected 0`);
assert(first.miss > 0, `run1 prompt_cache_miss_tokens was ${first.miss}, expected > 0`);
assert(second.hit > 0, `run2 prompt_cache_hit_tokens was ${second.hit}, expected > 0`);
assert(
  second.hit + second.miss === second.prompt,
  `run2 cache ${second.hit} + ${second.miss} != prompt_tokens ${second.prompt}`,
);
console.log('cache-smoke: OK');
