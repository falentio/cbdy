import { resolveCredentials, type Credentials } from './auth.ts';
import { collect, decodeStream } from './decode.ts';
import { requestErrorFrom } from './errors.ts';
import { encodeChatRequest, type EncodeOptions } from './encode.ts';
import type { OpenAiChatRequest, OpenAiChunk, OpenAiCompletion } from './types.ts';

export const DEFAULT_BASE_URL = 'https://www.codebuddy.ai/v2';

/** The CLI mints UUIDv7 ids, so a v4 may be rejected where a timestamped id is expected. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ChatOptions extends EncodeOptions {
  baseUrl?: string;
  credentials?: Credentials;
  fetch?: typeof fetch;
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
  const requestId = uuidv7().replaceAll('-', '');
  const conversationRequestId = uuidv7().replaceAll('-', '');
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    'content-type': 'application/json',
    // The server reads the account uid from x-user-id, and rejects requests whose
    // x-domain does not match the host it is served from.
    'x-user-id': credentials.userId,
    'x-domain': host,
    'x-product': 'SaaS',
    'user-agent': 'CLI/2.168.0 CodeBuddy/2.168.0',
    'x-agent-purpose': 'conversation',
    'x-agent-intent': agentName,
    'x-agent-type': 'main',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-codebuddy-request': '1',
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
  const doFetch = options.fetch ?? fetch;

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...requestHeaders(credentials, baseUrl, 'craft', options.conversationId ?? uuidv7()),
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
