# @auth-conformance/core

Declarative API **authorization contract testing** for TypeScript — extracted
from the Ping the Human project so any HTTP API can use it.

You declare *who* calls *which endpoint* and *what must happen*. The library
expands those declarations into deterministic, stable-ordered cases, executes
them against your real (or sandboxed) HTTP service, and reports policy
mismatches with redacted, human-readable diffs.

## Authoring

Define actors as per-case session factories, then declare one request and one
expectation per case:

```ts
import {
  authorizationContract,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";

const contract = authorizationContract({
  name: "service-authorization",
  baseUrl: () => process.env.AUTHORIZATION_BASE_URL!,
  error: {
    code: (body) => readErrorCode(body),
  },
  lifecycle: sandbox.lifecycle,
})
  .actor("anonymous", sessions.anonymous())
  .actor("member", sessions.bearer(({ fixture }) => fixture.memberToken));

contract
  .case("members can list their devices")
  .as("member")
  .get("/devices")
  .expectStatus(200);

const authorizationTests = contract.build();
await runAuthorizationTests(authorizationTests);
```

Rules can expand across the operation inventory returned by `fromOpenApi`.
Parameterized OpenAPI paths fail closed until the rule API gains an explicit
fixture-to-path-parameter model; the runner never requests a literal template
path. Contracts that only assert error status may omit `error`; supplying an
error code to `expectError` is type-available only when an envelope reader is
configured. See [docs/API_REDESIGN.md](docs/API_REDESIGN.md) for the complete
contract.

## Layout

```
packages/conformance/   the library (this workspace's only package)
  src/authoring.ts      four-symbol public API facade
  src/authoring-*.ts    contract building, expectations, and execution
  src/openapi-inventory.ts
                        OpenAPI operation discovery for rules
  src/model.ts          internal Actor / Operation / AuthorizationCase IR
  src/runner.ts         internal execution and reporting engine
  tests/                bun:test suite
```

## Development

```bash
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test packages
bun run build
bun run test:package
```

`test:package` packs `@auth-conformance/core`, asserts the tarball allowlist,
installs it in a temporary project outside the workspace, compiles positive and
negative consumer type cases against the emitted declarations, and executes the
compiled consumer with Node.js.

## Core lifecycle

Each case receives a fresh fixture from `lifecycle.create()`. Its actor session
factory resolves once against that fixture, contributes headers and cookies,
and the runner issues exactly one HTTP request. The configured expectation then
evaluates the response before `lifecycle.dispose(fixture)` runs. Cases and
expanded rules are returned in stable case-ID order.
