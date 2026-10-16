import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { collect, decodeStream, parseChunk, splitSseFrames } from '../src/decode.ts';
import { CodeBuddyRequestError } from '../src/errors.ts';
import type { OpenAiChunk } from '../src/types.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const streamOf = (...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
};

async function drain(chunks: AsyncGenerator<OpenAiChunk>): Promise<OpenAiChunk[]> {
  const collected: OpenAiChunk[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

const chunkOf = (delta: Record<string, unknown>, finishReason: string | null = null): OpenAiChunk => ({
  id: 'chunk-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'default-model',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  usage: null,
});

test('parseChunk classifies payloads', () => {
  assert.equal(parseChunk('[DONE]'), 'done');
  assert.equal(parseChunk(''), null);
  assert.equal(parseChunk('not json'), null);
  assert.equal(parseChunk('null'), null);
  assert.equal(parseChunk('{"code":11128,"msg":"nope"}'), null, 'an envelope is not a chunk');

  const chunk = parseChunk(
    '{"object":"chat.completion.chunk","id":"chunk-1","created":1,"model":"default-model","choices":[]}',
  );
  assert.ok(chunk !== null && chunk !== 'done');
  assert.equal(chunk.id, 'chunk-1');
});

test('splitSseFrames keeps a frame that straddles a chunk boundary in rest', () => {
  const sse = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  const cut = sse.indexOf('2}');

  const head = splitSseFrames(sse.slice(0, cut));
  assert.deepEqual(head.payloads, ['{"a":1}']);
  assert.equal(head.rest, 'data: {"b":');

  const tail = splitSseFrames(head.rest + sse.slice(cut));
  assert.deepEqual(tail.payloads, ['{"b":2}']);
  assert.equal(tail.rest, '');
});

test('splitSseFrames joins several data lines into one payload', () => {
  const { payloads, rest } = splitSseFrames('data: {"a":\ndata: 1}\n\n');

  assert.deepEqual(payloads, ['{"a":\n1}']);
  assert.equal(rest, '');
});

test('splitSseFrames handles CRLF frames', () => {
  const { payloads, rest } = splitSseFrames('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n');

  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '');
});

test('splitSseFrames ignores comment, event and unknown fields', () => {
  const sse = ': keepalive\nevent: message\nid: 7\nretry: 100\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
  const { payloads, rest } = splitSseFrames(sse);

  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '');
});

test('a frame without a data line yields no payload', () => {
  const { payloads, rest } = splitSseFrames('event: ping\n\n: keepalive\n\n');

  assert.deepEqual(payloads, []);
  assert.equal(rest, '');
});

test('decodeStream reads a captured stream whose frames straddle a chunk boundary', async () => {
  const sse = fixture('001-response.sse');
  const secondLine = sse.indexOf('\n\n') + 2;
  const cut = secondLine + 17;
  assert.ok(cut > secondLine && cut < sse.indexOf('\n', secondLine), 'the cut lands inside a frame');

  const whole = await drain(decodeStream(streamOf(sse)));
  const piecewise = await drain(decodeStream(streamOf(sse.slice(0, cut), sse.slice(cut))));

  assert.deepEqual(piecewise, whole);
  assert.equal(piecewise.length, 4, 'four chunks arrive before [DONE]');
});

test('decodeStream stops at [DONE] and drops what follows', async () => {
  const frame = (text: string): string =>
    `data: {"object":"chat.completion.chunk","id":"c1","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}`;

  const chunks = await drain(
    decodeStream(streamOf(`${frame('A')}\n\n${frame('B')}\n\ndata: [DONE]\n\n${frame('C')}\n\n`)),
  );

  assert.equal(chunks.length, 2, 'the chunk after [DONE] is dropped');
  assert.equal(chunks[0]?.choices[0]?.delta['content'], 'A');
  assert.equal(chunks[1]?.choices[0]?.delta['content'], 'B');
});

test('decodeStream ignores comment and event lines around a real frame', async () => {
  const frames = fixture('001-response.sse').split('\n\n');
  const real = frames[1];
  assert.ok(real !== undefined && real.startsWith('data: '), 'the fixture holds a real frame');

  const chunks = await drain(
    decodeStream(streamOf(`: keepalive\nevent: message\n${real}\n\ndata: [DONE]\n\n`)),
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.choices[0]?.delta['content'], 'P');
});

test('the captured response collects to PONG with a usage block', async () => {
  const completion = collect(await drain(decodeStream(streamOf(fixture('001-response.sse')))));

  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.id, '01a143fa4f5d783aad5da1f9b250a8f3');
  assert.equal(completion.model, 'default-model');
  assert.equal(completion.choices.length, 1);
  assert.equal(completion.choices[0]?.message.role, 'assistant');
  assert.equal(completion.choices[0]?.message.content, 'PONG');
  assert.equal(completion.choices[0]?.finish_reason, 'stop');
  assert.equal(completion.usage?.prompt_tokens, 22098);
  assert.equal(completion.usage?.completion_tokens, 2);
  assert.equal(completion.usage?.total_tokens, 22100);
  assert.equal(completion.usage?.prompt_cache_hit_tokens, 14336);
  assert.equal(completion.usage?.prompt_cache_miss_tokens, 7762);
  assert.equal(completion.usage?.completion_thinking_tokens, 0);
  assert.equal(completion.usage?.credit, 0.93);
});

test('collect omits tool_calls and reasoning_content on a plain answer', async () => {
  const completion = collect(await drain(decodeStream(streamOf(fixture('001-response.sse')))));
  const message = completion.choices[0]?.message;

  assert.ok(message !== undefined);
  assert.equal(Object.hasOwn(message, 'tool_calls'), false);
  assert.equal(Object.hasOwn(message, 'reasoning_content'), false);
});

test('collect carries reasoning_content through to the message', () => {
  const completion = collect([
    chunkOf({ role: 'assistant', content: '', reasoning_content: 'Add the two numbers' }),
    chunkOf({ content: '4', reasoning_content: ' to get four' }, 'stop'),
  ]);
  const message = completion.choices[0]?.message;

  assert.ok(message !== undefined);
  assert.equal(message.content, '4');
  assert.equal(message.reasoning_content, 'Add the two numbers to get four');
});

test('the captured tool call stream accumulates one get_weather call', async () => {
  const completion = collect(
    await drain(decodeStream(streamOf(fixture('tool-call-stream.sse')))),
  );
  const message = completion.choices[0]?.message;

  assert.ok(message !== undefined);
  assert.equal(message.content, "I'll call the get_weather tool for Paris right now.");
  assert.deepEqual(message.tool_calls, [
    {
      id: 'call_c4d2ed17074d445eb4c2e4a6',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city": "Paris"}' },
    },
  ]);
  assert.equal(completion.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(completion.usage?.total_tokens, 203);
});

test('the captured answer survives byte level chunking', async () => {
  const bytes = new TextEncoder().encode(fixture('tool-result-stream.sse'));
  const pieces: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += 7) pieces.push(bytes.slice(index, index + 7));

  const completion = collect(await drain(decodeStream(streamOf(...pieces))));
  const message = completion.choices[0]?.message;

  assert.ok(message !== undefined);
  assert.equal(
    message.content,
    'The weather in Paris is currently **18°C and sunny**. It looks like a lovely day! ☀️',
  );
  assert.equal(completion.choices[0]?.finish_reason, 'stop');
});

test('a JSON error body throws the CodeBuddyError envelope', async () => {
  const body =
    '{"code":11128,"msg":"first message is not system prompt","displayTips":{"en":"This call failed channel verification."},"actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}';

  await assert.rejects(drain(decodeStream(streamOf(body))), (error: unknown) => {
    assert.ok(error instanceof CodeBuddyRequestError, 'a request error is thrown');
    assert.equal(error.code, 11128);
    assert.equal(error.envelope.msg, 'first message is not system prompt');
    assert.deepEqual(error.envelope.actions, ['EDIT_INPUT', 'SUBMIT_FEEDBACK']);
    return true;
  });
});

test('an error envelope framed as a data line throws too', async () => {
  const body =
    'data: {"code":11101,"msg":"Non-stream chat request is currently not supported"}\n\n';

  await assert.rejects(drain(decodeStream(streamOf(body))), (error: unknown) => {
    assert.ok(error instanceof CodeBuddyRequestError, 'a request error is thrown');
    assert.equal(error.code, 11101);
    assert.equal(error.envelope.msg, 'Non-stream chat request is currently not supported');
    return true;
  });
});

test('collect falls back to a plain reasoning delta', () => {
  const chunks = [
    {
      id: 'x',
      object: 'chat.completion.chunk' as const,
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta: { reasoning: 'thinking' }, finish_reason: '' }],
    },
    {
      id: 'x',
      object: 'chat.completion.chunk' as const,
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }],
    },
  ];
  const completion = collect(chunks as never);
  assert.equal(completion.choices[0]?.message.reasoning_content, 'thinking');
  assert.equal(completion.choices[0]?.message.content, 'answer');
});
