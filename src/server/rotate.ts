import type { Credentials } from '../auth.ts';
import { completeChat, streamChat, type ChatOptions } from '../client.ts';
import type { OpenAiChatRequest, OpenAiChunk, OpenAiCompletion } from '../types.ts';

export const ATTEMPTS_PER_ACCOUNT = 2;
export const COOLDOWN_MS = 60_000;

export interface RotationCandidate {
  uid: string;
  credentials: Credentials;
}

interface Penalty {
  fails: number;
  penalizedUntil: number;
}

export interface ChatImpl {
  streamChat(request: OpenAiChatRequest, options: ChatOptions): AsyncGenerator<OpenAiChunk>;
  completeChat(request: OpenAiChatRequest, options: ChatOptions): Promise<OpenAiCompletion>;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Rotator {
  private readonly chat: ChatImpl;
  private readonly penalties = new Map<string, Penalty>();

  constructor(chat: ChatImpl = { streamChat, completeChat }) {
    this.chat = chat;
  }

  async *stream(
    request: OpenAiChatRequest,
    candidates: RotationCandidate[],
    options: ChatOptions,
  ): AsyncGenerator<OpenAiChunk> {
    let lastError: unknown;
    for (const candidate of this.eligible(candidates)) {
      for (let attempt = 0; attempt < ATTEMPTS_PER_ACCOUNT; attempt++) {
        let yielded = false;
        try {
          for await (const chunk of this.chat.streamChat(request, this.optionsFor(options, candidate))) {
            yielded = true;
            yield chunk;
          }
          this.penalties.delete(candidate.uid);
          return;
        } catch (error) {
          lastError = error;
          this.recordFailure(candidate.uid, error);
          if (yielded) throw error;
        }
      }
    }
    throw lastError;
  }

  async complete(
    request: OpenAiChatRequest,
    candidates: RotationCandidate[],
    options: ChatOptions,
  ): Promise<OpenAiCompletion> {
    let lastError: unknown;
    for (const candidate of this.eligible(candidates)) {
      for (let attempt = 0; attempt < ATTEMPTS_PER_ACCOUNT; attempt++) {
        try {
          const completion = await this.chat.completeChat(request, this.optionsFor(options, candidate));
          this.penalties.delete(candidate.uid);
          return completion;
        } catch (error) {
          lastError = error;
          this.recordFailure(candidate.uid, error);
        }
      }
    }
    throw lastError;
  }

  private eligible(candidates: RotationCandidate[]): RotationCandidate[] {
    const now = Date.now();
    const ready = candidates.filter(
      (candidate) => (this.penalties.get(candidate.uid)?.penalizedUntil ?? 0) <= now,
    );
    return ready.length > 0 ? ready : candidates;
  }

  private optionsFor(options: ChatOptions, candidate: RotationCandidate): ChatOptions {
    return { ...options, credentials: candidate.credentials };
  }

  private recordFailure(uid: string, error: unknown): void {
    const penalty = this.penalties.get(uid) ?? { fails: 0, penalizedUntil: 0 };
    penalty.fails += 1;
    if (penalty.fails < ATTEMPTS_PER_ACCOUNT) {
      this.penalties.set(uid, penalty);
      return;
    }
    penalty.fails = 0;
    penalty.penalizedUntil = Date.now() + COOLDOWN_MS;
    this.penalties.set(uid, penalty);
    console.warn(`account ${uid} failed: ${messageFrom(error)}; cooling down for ${COOLDOWN_MS / 1000}s`);
  }
}
