import type { CodeBuddyChatRequest, CodeBuddyMessage, OpenAiChatRequest } from './types.ts';

export interface EncodeOptions {
  models: Record<string, string>;
  defaultModel: string;
  systemPrompt: string;
  maxTokens?: number;
  cacheRetention?: 'long';
  extraVars?: Record<string, string>;
}

export function resolveModel(requested: string, options: EncodeOptions): string {
  return options.models[requested] ?? options.defaultModel;
}

export function encodeChatRequest(
  request: OpenAiChatRequest,
  options: EncodeOptions,
): CodeBuddyChatRequest {
  const [first] = request.messages;
  // messages[0] must be a system turn or the server answers 11128 before it looks at anything else.
  const messages: CodeBuddyMessage[] =
    first?.role === 'system'
      ? [...request.messages]
      : [{ role: 'system', content: options.systemPrompt }, ...request.messages];

  const maxTokens = request.max_tokens ?? options.maxTokens;

  // stream:false is rejected with 11101, and usage is null in the last chunk without include_usage.
  const encoded: CodeBuddyChatRequest = {
    model: resolveModel(request.model, options),
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.temperature !== undefined) encoded.temperature = request.temperature;
  if (request.top_p !== undefined) encoded.top_p = request.top_p;
  if (request.stop !== undefined) encoded.stop = request.stop;
  if (maxTokens !== undefined) encoded.max_tokens = maxTokens;
  if (request.tools !== undefined && request.tools.length > 0) encoded.tools = request.tools;
  if (options.cacheRetention !== undefined) encoded.cache_retention = options.cacheRetention;
  if (options.extraVars !== undefined && Object.keys(options.extraVars).length > 0) {
    encoded.extra_vars = options.extraVars;
  }

  return encoded;
}
