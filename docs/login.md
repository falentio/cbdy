# CodeBuddy login on the international site

Reverse engineered from live traffic against `www.codebuddy.ai` and from
`codebuddy-headless.js` 2.168.0. Labels mean the same as in
`./docs/protocol.md`: **probed** means a script here reproduced it,
**read** means it is a literal in the bundle.

A complete login was driven end to end while writing this. The account it
produced then answered an inference request.

## The flow

```text
login() [1]
├── requestLogin() [1a] ← POST /v2/plugin/auth/state?platform=CLI, unauthenticated
│   └── append version=<cli version> to authUrl [1a1]
├── hand the URL to the user [1b] ← the only step a human does
│   └── browser: SSO page, then /started [1b1]
├── waitForLogin() [1c]
│   └── GET /v2/plugin/auth/token?state=<state> every 2s [1c1]
│       ├── code 11217: still pending [1c1a]
│       └── code 0: the session token block [1c1b]
├── fetchAccounts() [1d] ← GET /v2/plugin/accounts with the new bearer
└── writeStoredSession() [1e] ← the file the CLI and ./src/auth.ts already read
```

The shape is a hand-off plus a pull. The browser never talks to the client, and
the client never receives a callback. The server holds the result under the
`state` the client generated, and the client polls for it.

## 1. Ask for a state

```http
POST https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI
X-No-Authorization: true
X-No-User-Id: true
X-No-Enterprise-Id: true
X-No-Department-Info: true
Content-Type: application/json

{}
```

```json
{ "code": 0, "msg": "OK", "requestId": "112a1349-...",
  "data": {
    "state": "2c7f39cb-aa53-459f-acd6-46a52eb466c1",
    "authUrl": "https://www.codebuddy.ai/login?platform=CLI&state=2c7f39cb-aa53-459f-acd6-46a52eb466c1"
  } }
```

The four `x-no-*` headers are what make this call work with no credential. This
endpoint is the one place in the API that accepts an unauthenticated request.

`openAuthUrl` in the bundle appends `version` to the URL, from the client's own
plugin version:

```text
https://www.codebuddy.ai/login?platform=CLI&state=<state>&version=2.168.0
```

That is the URL a user opens.

## 2. The user logs in

The page at `/login` runs the SSO and then sends the browser to the app:

```text
https://www.codebuddy.ai/started?platform=CLI&state=<state>&version=2.168.0
```

That redirect is what tells the user they are done. Nothing on it is read by the
client.

## 3. Poll for the token

```http
GET https://www.codebuddy.ai/v2/plugin/auth/token?state=<state>
```

While the browser has not finished:

```json
{ "code": 11217, "msg": "11217:login ing...", "requestId": "b3fa34ab-..." }
```

After it has:

```json
{ "code": 0, "msg": "OK", "requestId": "29e001cb-...",
  "data": {
    "accessToken": "<RS256 JWT>",
    "refreshToken": "<JWT, typ Offline>",
    "tokenType": "Bearer",
    "expiresIn": 31533758,
    "refreshExpiresIn": 31533758,
    "sessionState": "cec39390-c250-4f88-95ab-5f8562dc79cb",
    "scope": "openid profile offline_access email",
    "domain": "www.codebuddy.ai"
  } }
```

`data` is the `auth` block of the session file, verbatim. The client adds only
three computed fields (step 5). Nothing in this payload needs reshaping, which is
why `./src/login.ts` can store it as it arrives.

Both expiry values are about 365 days, in seconds. The `accessToken` is a
Keycloak JWT whose `exp` matches `expiresAt`, so the credential does not need
refreshing in practice and `./src/login.ts` does not implement it.

## 4. Fetch the account

```http
GET https://www.codebuddy.ai/v2/plugin/accounts
Authorization: Bearer <accessToken>
X-User-Id: <the token's sub claim>
X-Domain: www.codebuddy.ai
```

```json
{ "code": 0, "msg": "OK",
  "data": { "accounts": [ { "uid": "...", "nickname": "...", "uin": "...", "type": "personal",
    "lastLogin": true, "isCreator": false, "isAdmin": false, "pluginEnabled": true,
    "deployStatus": { "statusCode": 0, "statusMsg": "", "detailMsg": "" },
    "accountType": "", "sso": { "domain": "", "domainModifiedTimes": 0 }, "idp": "",
    "areaInfoComplete": true, "oneidAccountId": "",
    "isCurrentOneIdEnterprise": false, "isCurrentOneIdPersonal": false,
    "isFirstLogin": false, "logOutEnable": false } ] } }
```

That object is the session file's `account` block key for key, so it is stored
as it arrives. `./fixtures/login-accounts.json` holds this shape with the values
redacted.

## 5. Write the session file

```text
~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info
```

```json
{
  "account":     { "...": "from step 4" },
  "auth":        { "...": "from step 3",
                   "lastRefreshTime": 1792142540464,
                   "expiresAt":       1823677309182,
                   "refreshExpiresAt": 1823677309182 },
  "accounts":    [ { "...": "the same account" } ],
  "allAccounts": [ { "...": "the same account" } ]
}
```

`expiresAt = lastRefreshTime + expiresIn * 1000`. The CLI writes the file
atomically through a temp file and a rename, with mode `0600`, and creates the
parent directory. `./src/login.ts` does the same.

Once this file exists, both the CLI and `./src/auth.ts` pick it up with no
further setup, because `resolveCredentials` already reads that path.

## The identity behind the login

| Claim | Value |
| --- | --- |
| `iss` | `https://www.codebuddy.ai/auth/realms/copilot` |
| `aud` | `account` |
| `azp` | `console` |
| `sub` | the account uid, and the `x-user-id` value |
| `typ` | `Bearer` on the access token, `Offline` on the refresh token |
| `scope` | `openid profile offline_access email` |

It is a Keycloak realm named `copilot`, reached only through the `/v2/plugin`
handshake. A client never speaks OAuth directly to it: there is no client id,
redirect URI or PKCE verifier to choose, because the server owns both ends and
the client only holds a `state`.

## Refresh and logout

Both are **read** from the bundle and were not probed, because the token lives a
year and nothing here needed them.

```http
POST https://www.codebuddy.ai/v2/plugin/auth/token/refresh
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: plugin
X-Domain: www.codebuddy.ai
```

The response replaces the `auth` block the same way step 3 does.

```http
POST https://www.codebuddy.ai/v2/plugin/auth/logout
```

Logout also writes a marker beside the session file, at
`<session path>.logged-out`, which makes the CLI treat the stored session as
gone even before the file is rewritten.

## Reproducing this

```bash
# request a state and print the URL to open
node tools/login-state.mjs

# poll once for that state; 11217 means the browser is still working
node tools/login-state.mjs <state>
```

```ts
import { login } from './src/login.ts';

const { session, path } = await login({ onLoginUrl: (url) => console.log('open', url) });
console.log(session.account.nickname, 'signed in, session at', path);
```

`./scripts/login-smoke.ts` proves the whole chain. It requests a state, prints the
URL, waits for the browser, fetches the account, writes the session into a
temporary home, reads it back through `readStoredCredentials`, and answers one
inference request with it:

```bash
# a reviewer can re-run everything after the browser step from a saved poll response
node scripts/login-smoke.ts --from-capture <path to a saved token response>

# or drive a real login
node scripts/login-smoke.ts
```

`./.audit/proof/login-smoke.log` is the last run. It ends
`chat with the reloaded session: "LOGGEDIN"` and `login smoke: OK`.

## Where the numbers came from

| Observation | How |
| --- | --- |
| state endpoint accepts no credential | probed with no auth header |
| pending code 11217 | probed while the browser was mid-login |
| token payload fields and the 365 day expiry | probed, from a completed login |
| `/started` redirect | observed in the browser after the login |
| account shape | probed with the token the login produced |
| session file layout and computed fields | read from the bundle, and confirmed against the file the CLI writes |
| refresh and logout paths | read from the bundle |

## Still open

- Whether the `state` expires, and after how long.
- Whether one `state` can be polled after the token has been collected once.
- What `platform` may be other than `CLI`, and what changes if it does.
- Whether `version` is required, or only recorded.
