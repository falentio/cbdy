import type {
  CodeBuddyError,
  OpenAiChunk,
  OpenAiCompletion,
  OpenAiCompletionMessage,
  OpenAiToolCall,
  OpenAiUsage,
} from './types.ts';

const DATA_PREFIX = 'data:';

export function splitSseFrames(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  const frame: string[] = [];
  let frameStart = 0;
  let cursor = 0;

  while (cursor < buffer.length) {
    const newline = buffer.indexOf('\n', cursor);
    if (newline === -1) break;

    const rawLine = buffer.slice(cursor, newline);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    cursor = newline + 1;

    if (line === '') {
      if (frame.length > 0) {
        payloads.push(frame.join('\n'));
        frame.length = 0;
      }
      frameStart = cursor;
      continue;
    }

    if (!line.startsWith(DATA_PREFIX)) continue;

    const value = line.slice(DATA_PREFIX.length);
    frame.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  return { payloads, rest: buffer.slice(frameStart) };
}

export function parseChunk(payload: string): OpenAiChunk | 'done' | null {
  if (payload === '[DONE]') return 'done';

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  if ((parsed as Record<string, unknown>)['object'] !== 'chat.completion.chunk') return null;
  return parsed as OpenAiChunk;
}

function errorEnvelope(payload: string): CodeBuddyError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope['code'] !== 'number' || 'object' in envelope) return null;
  return parsed as CodeBuddyError;
}

export async function* decodeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let yieldedChunk = false;

  try {
    while (true) {
      const result = await reader.read();
      const text = result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      const { payloads, rest } = splitSseFrames(pending + text);
      pending = rest;

      for (const payload of payloads) {
        if (!yieldedChunk) {
          const envelope = errorEnvelope(payload);
          if (envelope !== null) throw envelope;
        }

        const chunk = parseChunk(payload);
        if (chunk === 'done') return;
        if (chunk === null) continue;

        yieldedChunk = true;
        yield chunk;
      }

      // An error response is JSON, not SSE, so it never terminates a frame and never reaches
      // the payload loop above.
      if (!yieldedChunk && payloads.length === 0) {
        const envelope = errorEnvelope(pending);
        if (envelope !== null) throw envelope;
      }

      if (result.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function collect(chunks: Iterable<OpenAiChunk>): OpenAiCompletion {
  let id = '';
  let created = 0;
  let model = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: OpenAiUsage | null = null;
  let first = true;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for (const chunk of chunks) {
    if (first) {
      id = chunk.id;
      created = chunk.created;
      model = chunk.model;
      first = false;
    }

    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;

    const choice = chunk.choices[0];
    if (choice === undefined) continue;

    const delta = choice.delta;
    if (typeof delta['content'] === 'string') content += delta['content'];
    if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content'];
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      finishReason = choice.finish_reason;
    }

    const fragments = delta['tool_calls'];
    if (!Array.isArray(fragments)) continue;

    for (const fragment of fragments) {
      if (typeof fragment !== 'object' || fragment === null) continue;

      const record = fragment as Record<string, unknown>;
      const index = typeof record['index'] === 'number' ? record['index'] : 0;
      const fn =
        typeof record['function'] === 'object' && record['function'] !== null
          ? (record['function'] as Record<string, unknown>)
          : {};

      const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof record['id'] === 'string' && record['id'] !== '') call.id = record['id'];
      if (typeof fn['name'] === 'string' && fn['name'] !== '') call.name = fn['name'];
      if (typeof fn['arguments'] === 'string') call.arguments += fn['arguments'];
      toolCalls.set(index, call);
    }
  }

  const message: OpenAiCompletionMessage = { role: 'assistant', content };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]): OpenAiToolCall => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}
