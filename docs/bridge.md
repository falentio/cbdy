# The adapter

Scope for this pass: the payload layer. A compatibility server is a later
change, and this note says where it would attach.

## What it is for

Something that already speaks OpenAI has to be able to reach
`https://www.codebuddy.ai/v2/chat/completions` without knowing it is
CodeBuddy. Per `./docs/protocol.md` the payloads are already close, so the
adapter is small on purpose:

```text
OpenAI request  [1]
└── encode() [1a] ← pure: OpenAI params in, CodeBuddy body out
    ├── requireSystemFirst() [1a1] ← prepend a system turn when absent
    ├── forceStream() [1a2] ← the server rejects stream:false
    └── mapModel() [1a3] ← OpenAI model name to product model id

CodeBuddy SSE  [2]
└── decodeStream() [2a] ← pure: SSE bytes in, OpenAI chunks out
    ├── splitSseFrames() [2b] ← data: lines, [DONE] terminator
    ├── parseChunk() [2c] ← content, tool_calls, finish_reason pass through
    └── collect() [2d] ← fold the stream into one completion for stream:false callers

Credentials  [3]
└── resolveAuth() [3a] ← boundary: read env or the CLI's own store, validate once
```

## Organizing structure

A typed wire model, two pure transforms over it, and one boundary module.

| Module | Responsibility | Kind |
| --- | --- | --- |
| `src/types.ts` | the CodeBuddy wire model and the OpenAI shapes it maps to | types only |
| `src/encode.ts` | OpenAI params to a `CodeBuddyChatRequest` | pure |
| `src/decode.ts` | an SSE body to OpenAI chunks, and a collector | pure |
| `src/auth.ts` | resolve a bearer token and user id | boundary |
| `src/errors.ts` | the two wire error envelopes as one `Error` | boundary |
| `src/client.ts` | post an encoded body, return a decoded stream | boundary |
| `src/index.ts` | the public surface | re-export |

The choice this encodes: the two transforms stay pure and fixture-testable, so
the only untested-by-unit-test code is the network and file reads, which the live
test covers. Splitting them differently, say one `translate()` that does both
directions, would put the parts that need no I/O behind the parts that do.

## Type choices

Two invariants get pushed into the types so no caller can violate them:

```ts
interface CodeBuddyChatRequest {
  model: string;
  messages: CodeBuddyMessage[];
  stream: true;                              // the server rejects false
  stream_options: { include_usage: true };   // the CLI always sends it; the server does not require it
  // ...
}
```

`stream` is the literal `true`, not `boolean`, and `stream_options` is not
optional, so a caller cannot build a request the server answers with 11101. The
second invariant is posture rather than necessity: probe v8 showed the last chunk
carries `usage` without it, and the field stays because the official client
sends it.

## Design decisions

### Where the adapter ends

| Option | What it gives | Why not |
| --- | --- | --- |
| Pure transforms only | no I/O at all, trivially testable | the point is to actually reach the endpoint |
| Transforms plus a client | one call from OpenAI params to a stream | chosen |
| A `fetch`-shaped drop-in | any OpenAI SDK could point at it | needs the server, which is out of scope this pass |
| A full openai-node clone | import swap | the largest surface for the smallest gain, and a server would wrap the client anyway |

The client returns the decoded async iterator, so a server is roughly twenty
lines: parse the HTTP request, call `chatCompletions`, re-emit as SSE.

### Model mapping

OpenAI callers send `gpt-4o` and friends, which mean nothing to CodeBuddy. The
adapter takes an explicit map and falls back to a configured default rather than
guessing by prefix, because a wrong guess bills the caller for a model it did
not ask for.

### stream: false

The server refuses it, so a non-streaming caller is served by collecting the
stream and returning one completion. That keeps the failure on the adapter's
side of the boundary instead of surfacing a 11101 to a caller that did nothing
wrong.

## What is not in this pass

- The HTTP server.
- Token refresh. An expired bearer surfaces as a 401 and the caller re-resolves.
- Retries and rate limiting.
