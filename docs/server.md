# The proxy service

An OpenAI-compatible HTTP endpoint backed by a pool of CodeBuddy accounts the
service manages itself. It never reads or writes the CLI's session file; the
CLI is unaffected. `./docs/bridge.md` deferred the HTTP server; this is it.

## Run it

    bun src/server/main.ts

Or as a systemd user service:

    mkdir -p ~/.config/systemd/user
    cp deploy/codebuddy-proxy.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    loginctl enable-linger   # keep the service alive after logout
    systemctl --user enable --now codebuddy-proxy

The unit runs `bun src/server/main.ts` from this checkout on port 8787. Edit
the copied unit to move the checkout or the port, then `daemon-reload`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET /` | the account page | list, add, remove, set active |
| `GET /healthz` | liveness | |
| `GET /api/accounts` | accounts and login status | |
| `POST /api/accounts/login` | start a login; returns the URL to open | |
| `DELETE /api/accounts/login` | abandon a pending login | |
| `DELETE /api/accounts/{uid}` | remove an account | |
| `POST /api/accounts/{uid}/active` | choose the active account | |
| `POST /v1/chat/completions` | inference, OpenAI shaped | |

`stream: true` streams SSE frames; anything else returns one completion
(the upstream refuses `stream: false`, so the adapter collects the stream).

## Accounts

State lives in `~/.local/share/codebuddy-proxy/accounts.json`, mode 0600,
written atomically. To add an account, open the page, click **Add account**,
and open the login URL it shows; the server polls CodeBuddy and the page flips
when the token lands. A restart resumes a login that is still pending.

To reuse the session the CLI already has, import it once:

    node scripts/import-cli-session.ts

The first account becomes active. Chat requests rotate across the pool: each one
tries the active account first, then the rest in stored order, and gives each
account two attempts before moving on. When a request exhausts an account's two
attempts, that account sits out for 60 seconds; later requests skip it during
the cooldown, so an account that is out of credits stops leading every request.
A failure after the first streamed chunk has reached the caller is not retried,
because the caller already has bytes. When every account fails, the last
upstream error is returned. Cooldowns live in memory and clear on restart.
Switch the lead with the page or `POST /api/accounts/{uid}/active`.

To pull accounts from a 9router installation instead, export them once and
import the file:

    node tools/export-9router-accounts.mjs
    node scripts/import-accounts.ts ~/.local/share/codebuddy-proxy/9router-accounts.json

The export defaults to `~/.local/share/codebuddy-proxy/9router-accounts.json`,
mode 0600, one entry per 9router `codebuddy-intl` connection. Re-importing the
same file refreshes credentials and keeps the nicknames already in the pool.

## Models

A request's `model` is sent to CodeBuddy verbatim unless it appears in the
settings map, so real ids such as `deepseek-v4.1-flash` work as-is and an
unknown id fails with a 502 carrying the upstream error. Map OpenAI-style
aliases in `~/.local/share/codebuddy-proxy/settings.json`, read at boot:

    { "models": { "gpt-4o": "default-model" }, "systemPrompt": "You are helpful." }

## What it does not do

No caller authentication: the service binds 127.0.0.1 and is meant for the
local machine. No token refresh: tokens live about a year per
`./docs/login.md`, and an expired bearer surfaces as a 502; re-add the
account. No rate limiting: `./docs/bridge.md` defers it.
