# CodeBuddy Code inference protocol

Reverse engineered from `@tencent-ai/codebuddy-code` 2.168.0, the bundle at
`~/.vite-plus/packages/@tencent-ai/codebuddy-code/8c6afef0-f0b9-4578-8b3e-06f71a836133/lib/node_modules/@tencent-ai/codebuddy-code/dist/codebuddy-headless.js`,
and live traffic captured with `./tools/capture-proxy.mjs`.

Every claim below is labelled with how it was established:

- **captured** means the bytes appear in `./fixtures/001-request.json` or `./fixtures/001-response.sse`.
- **probed** means a script in this repo reproduced it, with the probe result in the table below.
- **read** means it is a string in the bundle, with the line number given.

## Headline

The endpoint speaks OpenAI. A streamed response is `object: "chat.completion.chunk"`
SSE terminated by `data: [DONE]`, tool calls stream in OpenAI's indexed
`tool_calls` shape, and the request body is OpenAI's `/chat/completions` body
plus four extra keys. A compatibility layer does not have to translate the
format. It has to satisfy two server-side gates and attach credentials.

## Endpoint

```text
POST https://www.codebuddy.ai/v2/chat/completions
```

Resolution, per `codebuddy-headless.js`:

| Source | Wins when | Resulting path |
| --- | --- | --- |
| `CODEBUDDY_BASE_URL` | always, when set | `${CODEBUDDY_BASE_URL}/chat/completions` |
| product config `endpoint` | otherwise | `${endpoint}/v2/chat/completions` |

The env override does not add `/v2`, so set it to `https://host/v2` to mirror the
default path. Confirmed live: with `CODEBUDDY_BASE_URL=http://127.0.0.1:8899/v2`
the CLI issued `POST /v2/chat/completions`, and the proxy forwarded it to the real
host and got a real completion.

The product config is fetched at startup and cached as gzipped base64 in
`~/.codebuddy/local_storage/entry_<md5>.info`. Its `endpoint` is
`https://www.codebuddy.ai` and its `authentication.attributes` names
`tokenHeader: Authorization`, `tokenType: bearerToken`, and
`usernameHeader: X-User-Id`.

## Request headers

Captured from a real `codebuddy -p` run.

| Header | Required | Value |
| --- | --- | --- |
| `authorization` | yes | `Bearer <jwt>` |
| `content-type` | yes | `application/json` |
| `x-user-id` | yes | account uuid, also `account.uid` in the credential store |
| `x-domain` | yes | `www.codebuddy.ai` |
| `x-product` | yes | `SaaS` |
| `user-agent` | yes | `CLI/2.168.0 CodeBuddy/2.168.0` |
| `x-codebuddy-request` | no | `1` |
| `x-agent-purpose` | no | `conversation` |
| `x-agent-intent` | no | agent name, `craft` for the default cli agent |
| `x-ide-type`, `x-ide-name`, `x-ide-version` | no | `CLI`, `CLI`, `2.168.0` |
| `x-conversation-id` | no | session uuid |
| `x-request-id`, `x-root-request-id`, `x-conversation-request-id` | no | per request and per turn |
| `traceparent`, `b3`, `x-b3-*`, `baggage`, `x-trace-id` | no | W3C and B3 tracing |
| `x-stainless-*` | no | SDK fingerprint, not meaningful outside the Node SDK |

Decorative headers were left out of `./tools/probe.mjs`; the probes sent the
allowlisted subset above and were accepted.

## Request body

```json
{
  "model": "default-model",
  "messages": [ { "role": "system", "content": "..." }, { "role": "user", "content": "..." } ],
  "tools": [ { "type": "function", "function": { "name": "...", "description": "...", "parameters": {} } } ],
  "temperature": 1,
  "max_tokens": 24000,
  "stream": true,
  "stream_options": { "include_usage": true },
  "cache_retention": "long",
  "extra_vars": { "initiator": "user" }
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `model` | string | yes | a product config model id, for example `default-model`, `deep-model`, `kimi-k3` |
| `messages` | array | yes | `messages[0].role` must be `"system"`. See the gate below. |
| `stream` | `true` | yes | `false` is rejected with code 11101. |
| `stream_options` | object | no | `{"include_usage": true}` makes the last chunk carry `usage`. |
| `tools` | array | no | OpenAI function schemas, passed through unchanged. |
| `temperature` | number | no | product config default is 1. |
| `max_tokens` | number | no | product config per model, 24000 for `default-model`. |
| `cache_retention` | string | no | `"long"` in the capture. Dropping it still returns 200. |
| `extra_vars` | object | no | `{"initiator": "user"}` in the capture. Dropping it still returns 200. |

### Gate 1: the first message must be a system message

```json
{ "code": 11128, "msg": "first message is not system prompt",
  "displayTips": { "en": "This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client." },
  "actions": ["EDIT_INPUT", "SUBMIT_FEEDBACK"] }
```

The server checks the role of the first message, not the content. A 51 character
`"You are CodeBuddy Code, a helpful assistant."` passed where the CLI sends a
13 KB `"You are CodeBuddy Code..."` prompt, and returned 200. Gate 1 fires before
model validation, so a bad model id reports 11128 rather than an unknown model.

### Gate 2: streaming only

```json
{ "code": 11101, "msg": "Non-stream chat request is currently not supported" }
```

A client asked for `stream: false` has to be served by collecting the stream
server-side and returning one completion.

## Response

Content type `text/event-stream`, `data: <json>` lines only. No `event:` lines,
no comments, no keepalives in any capture. The stream ends with `data: [DONE]`.

```json
{"id":"...","model":"default-model","object":"chat.completion.chunk","created":1792141841,
 "choices":[{"index":0,
   "delta":{"role":"assistant","content":"","reasoning_content":"","function_call":null,
            "refusal":"","tool_calls":[],"extra_fields":null},
   "logprobs":null,"finish_reason":""}],
 "usage":null}
```

Deltas always carry the full key set with empty values. Fields worth knowing:

| Field | Meaning |
| --- | --- |
| `delta.content` | assistant text, a few characters at a time |
| `delta.reasoning_content` | thinking text, present on reasoning models |
| `delta.tool_calls` | OpenAI indexed tool calls, see below |
| `delta.function_call` | always `{\"name\":\"\",\"arguments\":\"\"}` on the final chunk |
| `delta.extra_fields` | null in every capture |
| `finish_reason` | `""`, then one of `stop`, `tool_calls` |
| `usage` | null until the last content chunk, then a full block |

Tool calls stream exactly as OpenAI streams them. The first chunk carries `id`,
`type`, `function.name` and the first fragment of `function.arguments`; later
chunks carry only `index` and more `arguments` fragments.

```json
{"typ":"tool_calls","function":{"name":"get_weather","arguments":"{"},"index":0}
{"typ":"tool_calls","function":{"name":"","arguments":"\"city\": "},"index":0}
{"typ":"tool_calls","function":{"name":"","arguments":"\"Paris\""},"index":0}
{"typ":"tool_calls","function":{"name":"","arguments":"}"},"index":0}
```

Sending the tool result back uses OpenAI shapes and works unchanged:

```json
{ "role": "assistant", "content": "", "tool_calls": [ { "id": "call_abc123", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } } ] },
{ "role": "tool", "tool_call_id": "call_abc123", "content": "18C sunny" }
```

`usage` extends OpenAI's block with billing and cache counters:

| Field | Notes |
| --- | --- |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | standard |
| `prompt_tokens_details.cached_tokens` | standard |
| `prompt_cache_hit_tokens` | prompt tokens served from cache |
| `prompt_cache_miss_tokens` | prompt tokens that cost full price |
| `completion_thinking_tokens` | thinking tokens, only billed on reasoning models |
| `credit` | charged credits, 0.93 for a two token reply against a 22 KB prompt |
| `prompt_cache_write_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | zero in every capture |

## Probe matrix

Run with `./tools/probe.mjs` against a capture. Bodies live in
`./fixtures/probes/`.

| Probe | Change | Result |
| --- | --- | --- |
| p1 | `{model, messages:[user], stream:true}` | 400, code 11128 |
| p2 | same without `stream` | 400, code 11101 |
| p5 | unknown model id | 400, code 11128 (gate 1 runs first) |
| v1 | captured system prompt, short user turn | 200, `PONG` |
| v2 | 51 character system prompt | 200, `PONG` |
| v3 | captured body minus `cache_retention` and `extra_vars` | 200, `PONG` |
| v4 | user `content` as a plain string | 200, `PONG` |
| v5 | captured body minus `tools` | 200, `PONG` |
| v6 | one OpenAI function tool | 200, streamed `tool_calls`, `finish_reason: "tool_calls"` |
| v7 | tool call plus tool result turn | 200, `finish_reason: "stop"` |

## Minimal working request

```json
{
  "model": "default-model",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Reply with exactly: PONG" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

## Reproducing this

```bash
# capture the CLI's own traffic through a logging proxy
node tools/capture-proxy.mjs &
CODEBUDDY_BASE_URL=http://127.0.0.1:8899/v2 codebuddy -p 'Reply with exactly: PONG'

# replay a candidate body with the captured credentials
node tools/probe.mjs /tmp/cbrev/capture/001-request.txt fixtures/probes/v2-system-short.json

# regenerate redacted fixtures from a capture
node tools/redact-capture.mjs /tmp/cbrev/capture fixtures
```

## Still open

- Whether `x-domain` and `x-product` are enforced or cosmetic.
- The full refresh flow for an expired bearer token.
- Whether the server accepts `stream_options.include_usage: false`.
- Rate limits and retry semantics.
