# Hono user/admin example

A tiny Hono API with deterministic in-memory users and synthetic bearer tokens.
It needs no secrets, database, or external service.

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
bun run build
bun test examples/hono-user-admin/tests/authorization.test.ts
```

The contract covers anonymous denial, own-user access, hidden cross-user access,
admin cross-user access, and both denied and allowed admin-endpoint access. A
cross-user request returns `404` rather than `403` so it does not reveal whether
the requested user exists.

[`openapi.json`](openapi.json) is the checked-in OpenAPI 3.1 contract.
