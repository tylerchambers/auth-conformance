# Hono user/admin example

A tiny Hono API with bearer tokens and server-side cookie sessions. Its
test-only HTTP provisioning endpoint keeps contract setup and cleanup black-box.

From the repository root, start it with:

```bash
bun run --cwd examples/hono-user-admin start
```

The server listens on `http://127.0.0.1:3000`. Provision two isolated users and
their credentials through HTTP, then exercise the public API:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"userCount":2}' http://127.0.0.1:3000/test/fixtures
curl -H 'Authorization: Bearer token-fixture-1-owner' \
  http://127.0.0.1:3000/users/fixture-1-owner
curl -H 'Authorization: Bearer token-fixture-1-admin' \
  http://127.0.0.1:3000/admin/audit
curl -X DELETE http://127.0.0.1:3000/test/fixtures/fixture-1
```

Run its real-loopback authorization contract with:

```bash
bun run --cwd examples/hono-user-admin test
```

The ten-case contract creates and deletes every fixture through HTTP. It covers
valid and invalid server-side cookie sessions, anonymous and malformed-bearer
denial, user-resource boundaries, admin access, and a fixture-derived PATCH
body with a combined status/header/body expectation. It loads
[`openapi.json`](openapi.json) with `fromOpenApi` and uses the spec's `admin`
tag to generate the normal-user denial case.

The OpenAPI 3.1 document is both API documentation and executable test input.
