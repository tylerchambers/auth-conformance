# @auth-conformance/conformance

Declarative API **authorization contract testing** for TypeScript — extracted
from the Ping the Human project so any HTTP API can use it.

You declare *who* calls *which endpoint* and *what must happen*. The library
expands those declarations into deterministic, stable-ordered cases, executes
them against your real (or sandboxed) HTTP service, and reports policy
mismatches with redacted, human-readable diffs.

## Status

This is a fresh extraction: the execution engine is complete and tested
(31 passing tests), but the public authoring API is about to be redesigned
around a fluent builder. See [docs/API_REDESIGN.md](docs/API_REDESIGN.md)
before writing new code against the current constructors.

## Layout

```
packages/conformance/   the library (this workspace's only package)
  src/model.ts          Actor / Operation / AuthorizationCase IR
  src/runner.ts         suite + runner, fixture sandbox, HTTP executor ports
  src/reporters.ts      console & JSON reporters
  src/redaction.ts      sensitive-value redaction
  src/openapi-coverage-policy.ts   OpenAPI operation coverage checks
  tests/                bun:test suite
```

## Development

```bash
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test packages
```

## Core concepts

- **Actor** — a named principal (`anonymous`, `bearer`, `browser`, `integration`)
  that applies credentials to outgoing requests via an injected provider.
- **Operation** — one public HTTP endpoint built from the current fixture context.
- **AuthorizationCase** — one actor × operation × expected-response scenario,
  plus optional postconditions.
- **AuthorizationInvariant** — a factory that expands into many cases
  (e.g. "every authenticated endpoint rejects anonymous callers").
- **FixtureSandbox** — consumer-owned port that installs, resets per case, and
  disposes isolated fixture state (e.g. a scratch Postgres database).
- **HttpClient** — consumer-owned transport port; bring your own fetch wrapper.

Everything is immutable and deterministically ordered by case ID, so reports
and CI diffs stay stable.
