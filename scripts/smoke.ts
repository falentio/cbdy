import { completeChat, streamChat } from '../src/client.ts';
import { readStoredCredentials } from '../src/auth.ts';

const ENCODE_OPTIONS = {
  models: { 'gpt-4o': 'default-model' },
  defaultModel: 'default-model',
  systemPrompt: 'You are a helpful assistant.',
  cacheRetention: 'long' as const,
  extraVars: { initiator: 'user' },
};

const request = {
  model: 'gpt-4o',
  messages: [{ role: 'user' as const, content: 'Reply with exactly: PONG' }],
};

const credentials = readStoredCredentials();
console.log(`credentials: ${credentials ? 'found' : 'MISSING'}`);
if (credentials) console.log(`user: ${credentials.userId}`);

const started = Date.now();
const chunks: string[] = [];
let usage: unknown;
for await (const chunk of streamChat(request, ENCODE_OPTIONS)) {
  const delta = chunk.choices[0]?.delta['content'];
  if (typeof delta === 'string') chunks.push(delta);
  if (chunk.usage) usage = chunk.usage;
}
const streamed = chunks.join('');
console.log(`stream: ${JSON.stringify(streamed)} in ${Date.now() - started}ms`);
console.log(`usage: ${JSON.stringify(usage)}`);

const completion = await completeChat(request, ENCODE_OPTIONS);
console.log(`complete: ${JSON.stringify(completion.choices[0]?.message.content)}`);
console.log(`finish_reason: ${completion.choices[0]?.finish_reason}`);

if (!streamed.includes('PONG')) throw new Error(`streamed text did not contain PONG: ${streamed}`);
if (completion.choices[0]?.message.content !== 'PONG') {
  throw new Error(`completed text was not PONG: ${completion.choices[0]?.message.content}`);
}
console.log('smoke: OK');
