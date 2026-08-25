# 🔐 auth-conformance

Authorization contract tests for any HTTP API. Author tests in TypeScript; target any language or framework that speaks HTTP.

## ⚡ Run the example

```bash
git clone https://github.com/tylerchambers/auth-conformance.git
cd auth-conformance
bun install --frozen-lockfile
bun run --cwd examples/hono-user-admin test
```

The runnable [Hono user/admin example](examples/hono-user-admin) starts a real loopback server and checks seven authorization cases.

## 🧪 Define a contract

```ts
import {
  authorizationContract,
  fromOpenApi,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";
import openApi from "./openapi.json";

type Fixture = {
  userToken: string;
  adminToken: string;
  ownUserId: string;
  otherUserId: string;
};

const contract = authorizationContract<Fixture>({
  name: "user-authorization",
  baseUrl: () => "http://127.0.0.1:3000",
  operations: fromOpenApi(openApi),
  lifecycle: {
    async create() {
      return {
        userToken: "test-user-token",
        adminToken: "test-admin-token",
        ownUserId: "user-1",
        otherUserId: "user-2",
      };
    },
    async dispose() {},
  },
})
  .actor("user", sessions.bearer(({ fixture }) => fixture.userToken))
  .actor("admin", sessions.bearer(({ fixture }) => fixture.adminToken));

contract
  .case("users can read themselves")
  .as("user")
  .get("/users/:userId", {
    params: { userId: ({ fixture }) => fixture.ownUserId },
  })
  .expectBody({ id: "user-1" });

contract
  .case("users cannot discover other users")
  .as("user")
  .get("/users/:userId", {
    params: { userId: ({ fixture }) => fixture.otherUserId },
  })
  .expectError(404);

contract
  .rule("users cannot access admin operations")
  .forOperations({ tags: ["admin"] })
  .as("user")
  .expectError(403);

const report = await runAuthorizationTests(contract.build());
if (report.outcome !== "passed") {
  throw new Error(JSON.stringify(report, null, 2));
}
```

See [`examples/hono-user-admin`](examples/hono-user-admin) for the API, OpenAPI document, and complete contract.

## 📦 Package locally

The package is not published to npm yet.

```bash
cd packages/conformance
bun pm pack --filename ../../auth-conformance-core.tgz
cd ../..
bun add /absolute/path/to/auth-conformance-core.tgz
```

## Development

```bash
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun run test
bun run build
bun run test:package
```
