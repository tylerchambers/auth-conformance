# 🔐 auth-conformance

Authorization contract tests for any HTTP API. Author tests in TypeScript; target any language or framework that speaks HTTP.

## ⚡ Run the example

```bash
git clone https://github.com/tylerchambers/auth-conformance.git
cd auth-conformance
bun install --frozen-lockfile
bun run --cwd examples/hono-user-admin test
```

The runnable [Hono user/admin example](examples/hono-user-admin) provisions and
cleans up isolated fixtures over HTTP, then checks ten bearer- and cookie-auth
cases against a real loopback server.

## 🧪 Define a contract

```ts
import {
  authorizationContract,
  fromOpenApi,
  runAuthorizationTests,
  sessions,
} from "auth-conformance";
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
  .expectResponse(({ fixture }) => ({
    status: 200,
    body: { id: fixture.ownUserId },
  }));

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

const report = await runAuthorizationTests(contract.build(), {
  signal: AbortSignal.timeout(30_000),
});
if (report.outcome !== "passed") {
  throw new Error(JSON.stringify(report, null, 2));
}
```

See [`examples/hono-user-admin`](examples/hono-user-admin) for the API, OpenAPI document, and complete contract.

## 📦 Install

[`auth-conformance`](https://www.npmjs.com/package/auth-conformance) is
published on npm:

```bash
bun add auth-conformance
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

## Publishing

`auth-conformance` is the only canonical package name. Configure its npm trusted
publisher with:

- GitHub owner: `tylerchambers`
- Repository: `auth-conformance`
- Workflow: `publish.yml`
- Environment: leave blank

For each release, update `packages/conformance/package.json`, merge only after
CI passes, and publish a GitHub release tagged with the matching `v<version>`
value. The publish workflow repeats every release gate and uses npm trusted
publishing with provenance.

