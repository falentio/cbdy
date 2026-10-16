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

export function codeBuddyErrorFrom(text: string): CodeBuddyError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope['code'] !== 'number' || 'object' in envelope) return null;
  return parsed as CodeBuddyError;
}

export function requestErrorFrom(status: number, body: string): Error {
  const envelope = codeBuddyErrorFrom(body);
  if (envelope !== null) return new CodeBuddyRequestError(envelope, status);
  return new Error(
    `CodeBuddy returned ${status} with a body that is not an error envelope: ${body.slice(0, 300)}`,
  );
}
