# Hono user/admin example

A tiny Hono API with deterministic users, bearer tokens, and server-side cookie
sessions. It needs no secrets, database, or external service.

From the repository root, start it with:

```bash
bun run --cwd examples/hono-user-admin start
```

The server listens on `http://127.0.0.1:3000`. Try the normal user and admin:

```bash
curl -H 'Authorization: Bearer token-user-1' http://127.0.0.1:3000/users/user-1
curl -H 'Authorization: Bearer token-admin' http://127.0.0.1:3000/admin/audit
```

Run its real-loopback authorization contract with:

```bash
bun run --cwd examples/hono-user-admin test
```

The nine-case contract includes valid and invalid server-side cookie sessions,
anonymous and malformed-bearer denial, user-resource boundaries, and admin
access. It loads [`openapi.json`](openapi.json) with `fromOpenApi` and uses the
spec's `admin` tag to generate the normal-user denial case.

The OpenAPI 3.1 document is both API documentation and executable test input.
