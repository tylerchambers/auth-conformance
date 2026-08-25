# @auth-conformance/core

Declarative authorization contract testing for TypeScript HTTP APIs.

Use this package when endpoint tests prove that requests work but do not fully
prove **who may perform them against which resources**. Contracts exercise a
running HTTP service with named actors and fresh fixtures, then return stable,
redacted reports for policy mismatches.

## Install

The package is not published to npm yet. Install a package artifact supplied by
your project or pack this checkout:

```bash
bun add /absolute/path/to/auth-conformance-core.tgz
```

The package is ESM-only, supports Node.js 20 or newer and Bun, and does not
require Bun globals at runtime.

## Quick start

Create `auth.conformance.ts`:

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

Run it while the target API is available:

```bash
TEST_API_URL=http://127.0.0.1:3000 \
TEST_MEMBER_TOKEN=replace-me \
bun auth.conformance.ts
```

`runAuthorizationTests` returns a report; it does not turn policy mismatches into
process failures for you. Check `report.outcome` as shown above when running in
CI.

## Model real authorization boundaries

Each case runs this lifecycle:

```text
create fixture -> resolve actor session -> send one request -> evaluate -> dispose
```

Fixtures make relationship tests repeatable. For example, resolve both the token
and path parameter from the same per-case fixture:

```ts
const contract = authorizationContract({
  name: "device-authorization",
  baseUrl: () => process.env.TEST_API_URL!,
  lifecycle: {
    async create() {
      return createMemberAndDevice();
    },
    async dispose(fixture) {
      await deleteMemberAndDevice(fixture);
    },
  },
}).actor(
  "member",
  sessions.bearer(({ fixture }) => fixture.memberToken),
);

contract
  .case("members can read their own device")
  .as("member")
  .get("/devices/:deviceId", {
    params: { deviceId: ({ fixture }) => fixture.deviceId },
  })
  .expectStatus(200);
```

Path parameters are required by the type surface and are URL-encoded. Request
builders also support headers and JSON-compatible bodies. For unusual methods
or request construction, use `.request(method, ({ fixture }) => request)`.

## Actors and expectations

`sessions` includes:

- `anonymous()`
- `bearer(tokenOrFactory)`
- `apiKey(headerName, keyOrFactory)`
- `cookies(cookiesOrFactory)`
- `fromHeaders(headersOrFactory)`

A case ends with exactly one expectation:

- `expectStatus(status)`
- `expectError(status)`
- `expectError(status, code)` when `error.code` is configured
- `expectBody(value)` or `expectBodyContaining(subset)`
- `expectNoContent()`
- `expectThat(({ response, fixture }) => ...)`

Configure coded error expectations at the contract boundary:

```ts
const contract = authorizationContract({
  name: "device-authorization",
  baseUrl: () => process.env.TEST_API_URL!,
  lifecycle,
  error: {
    code: (body) => readErrorCode(body),
  },
});
```

## OpenAPI rules

`fromOpenApi` accepts a parsed OpenAPI document, a local JSON path, or a `file:`
URL. Pass its inventory to the contract to expand a rule by tag or operation ID:

```ts
import {
  authorizationContract,
  fromOpenApi,
  sessions,
} from "@auth-conformance/core";

const operations = fromOpenApi(new URL("./openapi.json", import.meta.url));
const contract = authorizationContract({
  name: "anonymous-boundary",
  baseUrl: () => process.env.TEST_API_URL!,
  lifecycle,
  operations,
}).actor("anonymous", sessions.anonymous());

contract
  .rule("anonymous users cannot access device operations")
  .forOperations({ tags: ["devices"] })
  .as("anonymous")
  .expectError(401);
```

Every inventoried operation needs an `operationId`. Rules currently reject
parameterized OpenAPI paths instead of issuing a request to a literal template;
use explicit cases for those operations.

## Public API

The package exports four values:

- `authorizationContract`
- `fromOpenApi`
- `runAuthorizationTests`
- `sessions`
