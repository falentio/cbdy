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
| a `url` on the model entry | when set | that url, ahead of both of the above |

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
| `x-user-id` | no | account uuid, also `account.uid` in the credential store. A wrong value was accepted. |
| `x-domain` | no | `www.codebuddy.ai`. Dropping it was accepted. |
| `x-product` | no | `SaaS`. Dropping it was accepted. |
| `user-agent` | yes | `CLI/2.168.0 CodeBuddy/2.168.0` |
| `x-codebuddy-request` | no | `1` |
| `x-agent-purpose` | no | `conversation` |
| `x-agent-intent` | no | agent name, `craft` for the default cli agent |
| `x-ide-type`, `x-ide-name`, `x-ide-version` | no | `CLI`, `CLI`, `2.168.0` |
| `x-conversation-id` | yes | conversation uuid, with dashes |
| `x-conversation-request-id`, `x-root-request-id` | yes | one per turn, 32 hex characters, both the same value |
| `x-request-id`, `x-conversation-message-id` | yes | one per request, 32 hex characters, both the same value |
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
| `stream_options` | object | no | `{"include_usage": true}` when present. The last chunk carries `usage` with or without it. |
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

### Gate 2: a conversation id is required

```json
{ "code": 11128, "msg": "conversation id missing",
  "displayTips": { "en": "This call failed channel verification, possibly because it was not sent from an official client." } }
```

The conversation headers in the table above cannot be omitted. This gate does not
surface in an offline test, because it is a header check: the first version of
`./src/client.ts` passed all 28 fixture tests and was rejected live with this
code.

### Gate 3: streaming only

```json
{ "code": 11101, "msg": "Non-stream chat request is currently not supported" }
```

A client asked for `stream: false` has to be served by collecting the stream
server-side and returning one completion.

## Credentials

To obtain credentials in the first place, see `./docs/login.md`.

The CLI keeps its session at

```text
~/.local/share/CodeBuddyExtension/Data/Public/auth/<auth id>.info
```

where `<auth id>` is `productConfig.authentication.id`, which is
`Tencent-Cloud.coding-copilot` for the default endpoint. The bundle names a
`FileAuthenticationStorage` writing `.credentials.json`, but this install never
writes that file. The real path was found by tracing the CLI's file reads:

```bash
strace -f -e trace=openat -o strace.txt codebuddy -p 'hi'
grep -oE '"[^"]+"' strace.txt | sort -u | grep -i auth
```

```json
{
  "account": { "uid": "c06f162c-...", "nickname": "...", "uin": "..." },
  "auth": {
    "accessToken": "<RS256 JWT>",
    "refreshToken": "<JWT>",
    "tokenType": "Bearer",
    "scope": "openid profile offline_access email",
    "domain": "www.codebuddy.ai",
    "expiresAt": 1823677309182,
    "lastRefreshTime": 1792142540464
  },
  "accounts": []
}
```

Header values come from `productConfig.authentication.attributes`:
`tokenHeader: "Authorization"`, `tokenType: "bearerToken"`,
`usernameHeader: "X-User-Id"`, `usernameEncode: "URLEncode"`.

Some builds field-encrypt `auth.accessToken`, `auth.refreshToken` and the
account nicknames through a credential codec. The file read on this machine is
plain JSON with the token in the clear, so `./src/auth.ts` parses it directly
and would need the codec to read an encrypted one.

The access token is a Keycloak JWT whose `sub` claim equals `account.uid`, so
the user id header can be derived from the token alone. Other claims:
`preferred_username`, `email`, `realm_access`, `resource_access`.

### Token refresh

`refreshSession` in the bundle posts `/v2/auth/token/refresh` with the refresh
token in a header rather than the body. The product config sets
`attributes.prefixPath: "/plugin"`, and the external-link provider interpolates
it into every auth path, so the call this install makes is:

```http
POST https://www.codebuddy.ai/v2/plugin/auth/token/refresh
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: plugin
X-Domain: www.codebuddy.ai
```

The route regex `/^\/v2(\/[^/]+)?\/auth\/token\/refresh$/` on the server side
accepts either form.

### Login

The SSO flow is a browser handshake, not a pasted key:

1. `POST {endpoint}/v2/plugin/auth/state?platform=CLI` with `X-No-Authorization`,
   `X-No-User-Id`, `X-No-Enterprise-Id` and `X-No-Department-Info` set. The
   response carries `authUrl` and `state`.
2. Open `authUrl` in a browser.
3. Poll `GET {endpoint}/v2/plugin/auth/token?state=<state>` until it returns a
   usable token.
4. `GET {endpoint}/v2/plugin/accounts` for the account snapshot.

`/v1/auth/login` is unrelated. It resolves to `/api/v1/auth/login`, the local web
server's password login for callers of the CLI's own HTTP API.

### Overrides

`getAuthenticationAttributesSync` resolves a token in this order, and both env
vars beat the stored session:

| Source | Notes |
| --- | --- |
| `CODEBUDDY_AUTH_TOKEN` | a `Bearer ` prefix is stripped if present |
| `CODEBUDDY_API_KEY` | same treatment |
| `ACC_PRODUCT_CONFIG_V3` or `ACC_PRODUCT_CONFIG_V2` | JSON with `authentication.type: "custom-token"` |
| `ACC_PRODUCT_CONFIG_PATH` | same shape, from a file path |
| an `apiKey` on a product config model entry | the CLI's custom-key path |
| `apiKeyHelper` in settings | a script whose stdout is the key |
| the stored session file above | the default |

`CODEBUDDY_API_KEY_DISABLED` vetoes the env key. `CODEBUDDY_API_KEY_HELPER_DISABLED`
blocks the helper script.

A session built from an API key has no JWT, so the CLI invents the user id:
`ACC_USER_ID`, else `anonymous_` plus the last eight characters of the key. The
CLI sends an API key as both `Authorization: Bearer` and `X-API-Key`.
`./src/auth.ts` implements the env vars and the stored file, and reproduces the
`anonymous_` fallback.

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
| `delta.reasoning_content` | thinking text, present on reasoning models. The CLI also reads a plain `delta.reasoning` fallback. |
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
| `prompt_cache_miss_tokens` | prompt tokens that wrote a cache entry, despite the name |
| `completion_thinking_tokens` | thinking tokens, only billed on reasoning models |
| `credit` | charged credits, 0.93 for a two token reply against a 22 KB prompt |
| `prompt_cache_write_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | zero in every capture |

## Errors

Two envelopes exist. The CodeBuddy gateway answers with its own:

```json
{ "code": 11128, "msg": "first message is not system prompt",
  "requestId": "831b60d9-...",
  "displayMsg": { "en": "Request blocked. Please send it again", "zh": "...", "zh-hant": "..." },
  "displayTips": { "en": "This call failed channel verification...", "zh": "...", "zh-hant": "..." },
  "actions": ["EDIT_INPUT", "SUBMIT_FEEDBACK"] }
```

The upstream model adapter answers with OpenAI's:

```json
{ "error": { "code": "...", "type": "...", "message": "..." } }
```

`errorFromHttpResponse` in the bundle reads the second shape and takes the
request id from the `x-request-id` response header rather than the body. It maps
statuses to reasons: 401 and 403 to `Authentication`, 429 to `RateLimit` or
`QuotaExhausted`, 5xx to `ProviderInternal`, other 4xx to `InvalidRequest`.
`./src/errors.ts` parses both.

## Retries

The CLI disables retries inside the OpenAI SDK (`maxRetries: 0`) and runs its own
loop around the request.

| Knob | Default | Meaning |
| --- | --- | --- |
| `CODEBUDDY_MAX_RETRIES` | 1 | request level attempts, capped at 15 |
| `CODEBUDDY_MODEL_401_MAX_RETRIES` | 0 | attempts after a 401, capped at 15 |
| `CODEBUDDY_MODEL_401_RETRY_DELAY_MS` | 2000 | delay after a 401, capped at 32000 |
| `CODEBUDDY_STREAM_TIMEOUT_MS` | 1200000 | idle watchdog |
| `CODEBUDDY_MAX_RETRIES` | 1 | see above |

Retryable statuses are 408, 409, 429, 502, 503 and 529. The delay is the
`retry-after` header when present, otherwise exponential from 500 ms capped at
32 s. `./src/client.ts` does not retry; a caller that wants this loop owns it.

## Request signing

There is none. Authentication is bearer only, with `X-API-Key` as the alternative
header. The bundle's header enum carries `traceparent`, `b3` and `X-B3-*` for
tracing and no signature, nonce, or timestamp header.

## Product config, the /v3/config call

The CLI fetches its model catalog from `GET {endpoint}/v3/config` with
`params: {repos: ...}`, a 5 s timeout, and `Connection: close`. The response is
`{"data": {...}}` and supplies `models`, `agents`, `productFeatures`,
`authentication`, `telemetry` and `commands`.

A client does not need it. The package ships a bundled `product.json` with the
same endpoint and models, and `resolveModelBaseURL` falls back to
`CODEBUDDY_BASE_URL` and then to the product endpoint. `./src/client.ts` skips
the call entirely and takes the model id from its caller.

Cached copies live in `~/.codebuddy/local_storage/entry_<md5>.info` as gzipped
base64, which is where the model list in this document came from.

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
| v8 | stream:true with no `stream_options` | 200, last chunk still carries the full `usage` |
| A | a UUIDv4 `x-conversation-id` | 200, so the version does not matter |
| B | `x-user-id` set to all zeros | 200, so the header is not checked against the token |
| C | `x-domain` and `x-product` dropped | 200, so neither is enforced |
| smoke | v2 body through `./src/client.ts` with no conversation headers | 400, code 11128 "conversation id missing" |
| smoke | the same with the conversation headers | 200, streamed `PONG`, `prompt_tokens: 19` |

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

# the whole path, from an OpenAI request to a real streamed answer
node scripts/smoke.ts

# regenerate redacted fixtures from a capture
node tools/redact-capture.mjs /tmp/cbrev/capture fixtures
```

## Still open

- What `x-user-id`, `x-domain` and `x-product` are for. None is enforced, so
  `./src/client.ts` keeps sending them only to match the official client.
- Whether a `conversation id` has to correspond to a conversation the CLI
  created, or any fresh id will do.
- Whether the conversation id needs to be a UUID. A v4 was accepted, and
  `./src/client.ts` uses `crypto.randomUUID`.
- Whether any request the gateway rejects would be accepted with an
  `include_usage: false` stream option. Nothing suggests the value is read.
- Rate limits: the retry statuses and knobs above are read from the bundle, not
  measured against the live endpoint.
- Whether `X-API-Key` is accepted on the chat endpoint in place of the bearer.
