# auth-conformance

Authorization bugs rarely live in an endpoint's happy path. They appear when the
right request is made by the wrong user, against another tenant's resource, or
with a stale role. Ordinary endpoint tests can prove that `GET /devices` works;
they often do not prove that every actor gets the correct result for every
protected operation.

`@auth-conformance/core` turns that authorization matrix into executable
contracts for TypeScript HTTP APIs. A contract names an actor, builds a request
against a real service, and checks the policy result. The runner creates fresh
fixtures per case, applies the actor's credentials, and returns deterministic,
redacted failure reports.

## What this catches

- authenticated users reaching another user's or tenant's resources
- anonymous, stale, or under-privileged sessions receiving the wrong response
- policy drift between similar endpoints or HTTP methods
- new OpenAPI operations picked up by tag or all-operations rules
- error-envelope and response-body differences that a status-only test misses

## Quick start

You need [Bun](https://bun.sh/) 1.3.14 or a compatible release.

```bash
git clone https://github.com/tylerchambers/auth-conformance.git
cd auth-conformance
bun install --frozen-lockfile
bun test packages/conformance/tests/authoring.test.ts
```

That installs the workspace and runs the public authoring API tests. To verify
the complete repository, run the commands in [Development](#development).

For a runnable API, see the
[`examples/hono-user-admin`](examples/hono-user-admin) Hono example. It uses
synthetic bearer tokens and a real loopback listener. Start the API with:

```bash
bun run --cwd examples/hono-user-admin start
```

Or run its authorization contract, including an OpenAPI tag-based rule:

```bash
bun run --cwd examples/hono-user-admin test
```

The package is not published to npm yet. To try the package artifact from this
checkout:

```bash
cd packages/conformance
bun pm pack --filename ../../auth-conformance-core.tgz
cd ../..
# Run this from your API project, using the tarball's absolute path:
bun add /path/to/auth-conformance/auth-conformance-core.tgz
```

Then create an authorization contract alongside your API tests:

```ts
import {
  authorizationContract,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";

const lifecycle = {
  async create() {
    return { memberToken: process.env.TEST_MEMBER_TOKEN! };
  },
  async dispose() {},
};

const contract = authorizationContract({
  name: "device-authorization",
  baseUrl: () => process.env.TEST_API_URL!,
  lifecycle,
})
  .actor("anonymous", sessions.anonymous())
  .actor(
    "member",
    sessions.bearer(({ fixture }) => fixture.memberToken),
  );

contract
  .case("anonymous users cannot list devices")
  .as("anonymous")
  .get("/devices")
  .expectError(401);

contract
  .case("members can list devices")
  .as("member")
  .get("/devices")
  .expectStatus(200);

const report = await runAuthorizationTests(contract.build());
if (report.outcome !== "passed") {
  throw new Error(JSON.stringify(report, null, 2));
}
```

Run that file with your API available:

```bash
TEST_API_URL=http://127.0.0.1:3000 \
TEST_MEMBER_TOKEN=replace-me \
bun auth.conformance.ts
```

## Core mental model

Each case is one chain:

```text
fresh fixture -> actor session -> one HTTP operation -> one expectation
```

- **Lifecycle** creates and disposes isolated data for every case.
- **Actors** describe how a caller authenticates: anonymous, bearer token, API
  key, cookies, or custom headers.
- **Cases** target an explicit request. Typed `:pathParams` can resolve from the
  fixture.
- **Expectations** check a status, exact or partial body, no-content response,
  coded error envelope, or custom assertion.
- **Rules** expand an OpenAPI inventory by operation ID or tag into ordinary,
  stable-ordered cases.

## Practical next steps

1. Start with anonymous denial and one allowed actor for a protected endpoint.
2. Add relationship cases: own resource, another user's resource, and another
   tenant's resource.
3. Configure `error.code` if policy depends on stable application error codes.
4. Load a parsed or local JSON OpenAPI document with `fromOpenApi` to cover whole
   operation groups. Rule expansion currently rejects parameterized OpenAPI
   paths; write explicit cases for those endpoints.
5. Fail your test process when the returned report's `outcome` is not `passed`.

The package artifact's focused consumer documentation is in
[`packages/conformance/README.md`](packages/conformance/README.md).

## Repository layout

```text
packages/conformance/src/    package implementation
packages/conformance/tests/  Bun tests for authoring, execution, and reporting
examples/hono-user-admin/    runnable Hono user/admin authorization example
scripts/package-consumer/    isolated package consumer fixture
scripts/test-package.ts      pack/install/typecheck/runtime verification
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

`test:package` packs the package, checks the tarball allowlist, installs it in an
isolated project, compiles positive and negative consumer type cases, and runs
the compiled consumer with Node.js.
