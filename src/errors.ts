import type { CodeBuddyError } from './types.ts';

export class CodeBuddyRequestError extends Error {
  override name = 'CodeBuddyRequestError';
  readonly code: number;
  readonly envelope: CodeBuddyError;
  readonly status: number | undefined;

  constructor(envelope: CodeBuddyError, status?: number) {
    super(
      `CodeBuddy ${status === undefined ? 'stream' : 'http ' + status} error ${envelope.code}: ${envelope.msg}`,
    );
    this.envelope = envelope;
    this.status = status;
    this.code = envelope.code;
  }
}

/** The gateway's envelope: {code, msg, data?, displayMsg, displayTips, actions}. */
export function envelopeFrom<T>(text: string): (CodeBuddyError & { data?: T }) | null {
  const parsed = parseObject(text);
  if (parsed === null) return null;
  if (typeof parsed['code'] !== 'number' || 'object' in parsed) return null;
  return parsed as unknown as CodeBuddyError & { data?: T };
}

export function codeBuddyErrorFrom(text: string): CodeBuddyError | null {
  return envelopeFrom(text);
}

/** The upstream model adapter's envelope: {error: {code, type, message}}. */
export function upstreamErrorMessageFrom(text: string): string | null {
  const parsed = parseObject(text);
  const error = parsed?.['error'];
  if (typeof error !== 'object' || error === null) return null;
  const inner = error as Record<string, unknown>;
  const message = typeof inner['message'] === 'string' ? inner['message'] : 'no message';
  const type = typeof inner['type'] === 'string' ? inner['type'] : 'error';
  const code = typeof inner['code'] === 'string' ? `${inner['code']} ` : '';
  return `${type}: ${code}${message}`;
}

function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

export function requestErrorFrom(status: number, body: string): Error {
  const envelope = codeBuddyErrorFrom(body);
  if (envelope !== null) return new CodeBuddyRequestError(envelope, status);
  const upstream = upstreamErrorMessageFrom(body);
  if (upstream !== null) return new Error(`CodeBuddy returned ${status} with ${upstream}`);
  return new Error(
    `CodeBuddy returned ${status} with a body that is neither error envelope: ${body.slice(0, 300)}`,
  );
}
