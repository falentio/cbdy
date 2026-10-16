# codebuddy-reverse

Reverse engineering notes and an OpenAI shaped adapter for the CodeBuddy Code
inference API.

- `./docs/protocol.md` is the wire protocol, with every claim labelled captured,
  probed, or read from the bundle.
- `./docs/bridge.md` is the design of the adapter.
- `./tools/capture-proxy.mjs` logs the CLI's own traffic by setting
  `CODEBUDDY_BASE_URL` at it.
- `./tools/probe.mjs` replays a candidate request body with captured credentials.
- `./fixtures/` holds redacted captures and the probe bodies.

Captured traffic and the bundle are not vendored here. Both live on the machine
that ran the capture, under `/tmp/cbrev` and the CodeBuddy install directory.
