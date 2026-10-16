export type OpenAiContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAiContent | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface CodeBuddyMessage extends OpenAiMessage {
  agent?: string;
  conversationRequestId?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  tools?: OpenAiTool[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface CodeBuddyChatRequest {
  model: string;
  messages: CodeBuddyMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAiTool[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  cache_retention?: 'long';
  extra_vars?: Record<string, string>;
}

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_thinking_tokens?: number;
  credit?: number;
}

export interface OpenAiChunkChoice {
  index: number;
  delta: Record<string, unknown>;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface OpenAiChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage | null;
}

export interface OpenAiCompletionMessage {
  role: 'assistant';
  content: string;
  reasoning_content?: string;
  tool_calls?: OpenAiToolCall[];
}

export interface OpenAiCompletionChoice {
  index: number;
  message: OpenAiCompletionMessage;
  finish_reason: string | null;
}

export interface OpenAiCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAiCompletionChoice[];
  usage: OpenAiUsage | null;
}

export interface CodeBuddyError {
  code: number;
  msg: string;
  requestId?: string;
  displayMsg?: Record<string, string>;
  displayTips?: Record<string, string>;
  actions?: string[];
}
