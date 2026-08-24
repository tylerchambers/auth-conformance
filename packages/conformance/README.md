# @auth-conformance/core

Declarative authorization contract testing for TypeScript HTTP APIs.

## Install

Install a packed artifact locally:

```bash
bun add ./auth-conformance-core-0.1.0.tgz
```

The package is ESM-only and supports Node.js 20 or newer and Bun. Its runtime uses standard web APIs plus `node:` built-ins; it does not require Bun globals.

## Authoring

```ts
import {
  authorizationContract,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";

const lifecycle = {
  async create() {
    return { token: "fixture-token", deviceId: "device-1" };
  },
  async dispose() {},
};

const contract = authorizationContract({
  name: "service-authorization",
  baseUrl: () => "http://127.0.0.1:3000",
  lifecycle,
}).actor("member", sessions.bearer(({ fixture }) => fixture.token));

contract
  .case("members can read their devices")
  .as("member")
  .get("/devices/:deviceId", {
    params: { deviceId: ({ fixture }) => fixture.deviceId },
  })
  .expectStatus(200);

await runAuthorizationTests(contract.build());
```

Configure an error-envelope reader only when coded error expectations are needed:

```ts
const contract = authorizationContract({
  name: "service-authorization",
  baseUrl: () => "http://127.0.0.1:3000",
  lifecycle,
  error: {
    code: (body) => readErrorCode(body),
  },
});
```

The public package exports only `authorizationContract`, `fromOpenApi`, `runAuthorizationTests`, and `sessions`.
