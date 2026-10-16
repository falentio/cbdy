import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { encodeChatRequest, resolveModel } from '../src/encode.ts';
import type { EncodeOptions } from '../src/encode.ts';
import type { OpenAiChatRequest, OpenAiMessage, OpenAiTool } from '../src/types.ts';

const options: EncodeOptions = {
  models: { 'gpt-4o': 'deep-model' },
  defaultModel: 'default-model',
  systemPrompt: 'You are CodeBuddy Code, a helpful assistant.',
};

const userTurn: OpenAiMessage = { role: 'user', content: 'Reply with exactly: PONG' };

const v7: OpenAiChatRequest = JSON.parse(
  readFileSync(new URL('../fixtures/probes/v7-toolresult.json', import.meta.url), 'utf8'),
);

test('prepends the system prompt when the first message is not a system turn', () => {
  const request: OpenAiChatRequest = { model: 'gpt-4o', messages: [userTurn] };
  const encoded = encodeChatRequest(request, options);

  assert.equal(encoded.messages.length, 2);
  assert.deepEqual(encoded.messages[0], { role: 'system', content: options.systemPrompt });
  assert.equal(encoded.messages[1], userTurn, 'the caller message is forwarded by reference');
  assert.equal(request.messages.length, 1, 'the input array is left alone');
});

test('leaves a request that already starts with a system turn alone', () => {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    {
      role: 'user',
      content: [{ type: 'text', text: '<user_query>Reply with exactly: PONG</user_query>' }],
    },
  ];
  const encoded = encodeChatRequest({ model: 'gpt-4o', messages }, options);

  assert.deepEqual(encoded.messages, messages);
  assert.equal(encoded.messages.length, 2);
});

test('resolveModel maps a known name and falls back to the default', () => {
  assert.equal(resolveModel('gpt-4o', options), 'deep-model');
  assert.equal(resolveModel('gpt-4o-mini', options), 'default-model');
});

test('encodeChatRequest sends the mapped model and the default for an unmapped one', () => {
  assert.equal(
    encodeChatRequest({ model: 'gpt-4o', messages: [userTurn] }, options).model,
    'deep-model',
  );
  assert.equal(
    encodeChatRequest({ model: 'gpt-4o-mini', messages: [userTurn] }, options).model,
    'default-model',
  );
});

test('forces stream and include_usage even when the caller asked for stream:false', () => {
  const encoded = encodeChatRequest(
    { model: 'gpt-4o', messages: [userTurn], stream: false },
    options,
  );

  assert.equal(encoded.stream, true);
  assert.deepEqual(encoded.stream_options, { include_usage: true });
});

test('sets stream and include_usage when the caller sent neither', () => {
  const encoded = encodeChatRequest({ model: 'gpt-4o', messages: [userTurn] }, options);

  assert.equal(encoded.stream, true);
  assert.deepEqual(encoded.stream_options, { include_usage: true });
});

test('an assistant tool-call turn and a tool result turn survive the round trip unchanged', () => {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '<user_query>Call the get_weather tool for Paris.</user_query>' },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_abc123',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc123', content: '18C sunny' },
  ];
  const tools: OpenAiTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ];

  const encoded = encodeChatRequest(
    { model: 'gpt-4o-mini', messages, tools, temperature: 1, max_tokens: 24000 },
    options,
  );

  assert.equal(encoded.model, v7.model);
  assert.deepEqual(encoded.messages, v7.messages, 'the encoded turns match the v7 probe shape');
  assert.deepEqual(encoded.tools, v7.tools, 'the function schemas pass through unchanged');

  const assistant = encoded.messages[2];
  assert.ok(assistant !== undefined);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, '');
  assert.deepEqual(assistant.tool_calls, [
    {
      id: 'call_abc123',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    },
  ]);

  const toolResult = encoded.messages[3];
  assert.ok(toolResult !== undefined);
  assert.equal(toolResult.role, 'tool');
  assert.equal(toolResult.tool_call_id, 'call_abc123');
  assert.equal(toolResult.content, '18C sunny');
});

test('an assistant turn with null content keeps null content', () => {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      ],
    },
  ];
  const encoded = encodeChatRequest({ model: 'gpt-4o', messages }, options);
  const assistant = encoded.messages[1];

  assert.ok(assistant !== undefined);
  assert.equal(Object.hasOwn(assistant, 'content'), true);
  assert.equal(assistant.content, null);
});

test('omits optional keys rather than writing undefined', () => {
  const encoded = encodeChatRequest({ model: 'gpt-4o', messages: [userTurn] }, options);

  for (const key of [
    'tools',
    'temperature',
    'max_tokens',
    'top_p',
    'stop',
    'cache_retention',
    'extra_vars',
  ]) {
    assert.equal(Object.hasOwn(encoded, key), false, `${key} is absent`);
  }
});

test('writes the optional keys the request and the options set', () => {
  const tools = v7.tools ?? [];
  const encoded = encodeChatRequest(
    {
      model: 'gpt-4o',
      messages: [userTurn],
      tools,
      temperature: 1,
      max_tokens: 512,
      top_p: 0.9,
      stop: ['\n'],
    },
    { ...options, maxTokens: 24000, cacheRetention: 'long', extraVars: { initiator: 'user' } },
  );

  assert.equal(encoded.temperature, 1);
  assert.equal(encoded.top_p, 0.9);
  assert.deepEqual(encoded.stop, ['\n']);
  assert.deepEqual(encoded.tools, tools);
  assert.equal(encoded.max_tokens, 512, 'the request max_tokens wins over the option');
  assert.equal(encoded.cache_retention, 'long');
  assert.deepEqual(encoded.extra_vars, { initiator: 'user' });
});

test('falls back to the configured maxTokens and drops empty tools and extra_vars', () => {
  const encoded = encodeChatRequest(
    { model: 'gpt-4o', messages: [userTurn], tools: [] },
    { ...options, maxTokens: 24000, extraVars: {} },
  );

  assert.equal(encoded.max_tokens, 24000);
  assert.equal(Object.hasOwn(encoded, 'tools'), false, 'empty tools are omitted');
  assert.equal(Object.hasOwn(encoded, 'extra_vars'), false, 'empty extra_vars are omitted');
});

test('does not mutate the request it is given', () => {
  const request: OpenAiChatRequest = { model: 'gpt-4o', messages: [userTurn], stream: false };
  const before = structuredClone(request);

  encodeChatRequest(request, options);

  assert.deepEqual(request, before);
});
