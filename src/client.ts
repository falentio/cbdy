import { resolveCredentials, type Credentials } from './auth.ts';
import { collect, decodeStream } from './decode.ts';
import { requestErrorFrom } from './errors.ts';
import { encodeChatRequest, type EncodeOptions } from './encode.ts';
import type { OpenAiChatRequest, OpenAiChunk, OpenAiCompletion } from './types.ts';

export const DEFAULT_BASE_URL = 'https://www.codebuddy.ai/v2';

// Copied from a captured request. The server refuses a request it cannot place in a
// conversation, and the CLI's own client fingerprint is what makes it look official.
const CLIENT_FINGERPRINT = {
  'user-agent': 'CLI/2.168.0 CodeBuddy/2.168.0',
  'x-product': 'SaaS',
  'x-agent-type': 'main',
  'x-ide-type': 'CLI',
  'x-ide-name': 'CLI',
  'x-codebuddy-request': '1',
} as const;

export interface ChatOptions extends EncodeOptions {
  baseUrl?: string;
  credentials?: Credentials;
  /** Reuse one value across a conversation; a fresh one starts a new conversation. */
  conversationId?: string;
}

export function requestHeaders(
  credentials: Credentials,
  baseUrl: string,
  agentName: string,
  conversationId: string,
): Record<string, string> {
  const host = new URL(baseUrl).hostname;
  const requestId = crypto.randomUUID().replaceAll('-', '');
  const conversationRequestId = crypto.randomUUID().replaceAll('-', '');
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    'content-type': 'application/json',
    'x-user-id': credentials.userId,
    'x-domain': host,
    'x-agent-purpose': 'conversation',
    'x-agent-intent': agentName,
    ...CLIENT_FINGERPRINT,
    // Without these the server answers 11128 "conversation id missing".
    'x-conversation-id': conversationId,
    'x-request-id': requestId,
    'x-conversation-message-id': requestId,
    'x-conversation-request-id': conversationRequestId,
    'x-root-request-id': conversationRequestId,
  };
}

async function postChat(body: unknown, options: ChatOptions): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const credentials = options.credentials ?? resolveCredentials();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...requestHeaders(credentials, baseUrl, 'craft', options.conversationId ?? crypto.randomUUID()),
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw requestErrorFrom(response.status, await response.text());
  }
  if (!response.body) throw new Error(`empty response body, status ${response.status}`);
  return response.body;
}

export async function* streamChat(
  request: OpenAiChatRequest,
  options: ChatOptions,
): AsyncGenerator<OpenAiChunk> {
  // The endpoint refuses stream:false, so every request is streamed and a
  // non-streaming caller goes through completeChat instead.
  yield* decodeStream(await postChat(encodeChatRequest(request, options), options));
}

export async function completeChat(
  request: OpenAiChatRequest,
  options: ChatOptions,
): Promise<OpenAiCompletion> {
  const chunks: OpenAiChunk[] = [];
  for await (const chunk of streamChat(request, options)) chunks.push(chunk);
  return collect(chunks);
}
