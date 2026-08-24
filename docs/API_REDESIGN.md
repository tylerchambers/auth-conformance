# API Redesign: From Agent-Oriented to Human-Oriented

**Status:** proposal for discussion
**Scope:** `@auth-conformance/conformance` (the moved core only — no app-specific code)

---

## 1. Where we are

The library works, and its engine is solid: immutable cases, deterministic
stable-ordered expansion, a fixture sandbox lifecycle, redaction, OpenAPI
coverage policy, and structured reports. But its **authoring surface** reads
like infrastructure, not like a security policy.

Today, declaring "user A cannot delete user B's device" means:

1. Write an `Actor` (options object with a discriminated union on `authentication`).
2. Write an `Operation` (options object with `buildRequest(fixture)` callback).
3. Write an `ExpectedResponse` (options object with an `evaluate(response)` callback).
4. Write a class implementing `AuthorizationInvariant` whose `expand()` returns
   `AuthorizationCase[]`.
5. Wire actors/operations/resources into that class via a dependencies record.
6. Hand the invariants to `AuthorizationSuite`, then `AuthorizationRunner`.

Every one of those steps is a *machinery* decision. The actual authorization
assumption — who, what, what should happen — is buried inside step 3's
callback body and step 4's loop.

### Concrete example of today's shape

```ts
// One case, ~25 lines of ceremony:
new AuthorizationCase<PingTheHumanFixture>({
  id: "tracer-user-a-cannot-delete-user-b-device",
  actor: actors.userA,
  operation: operations.deleteDevice(resources.otherUsersDevice),
  expectedResponse: expectError(403, "DEVICE_NOT_FOUND"),
});
```

…and `expectError` itself constructs an `ExpectedResponse` whose `evaluate`
parses the response body to compare an error envelope. The reader must know
the framework to know what is being asserted.

## 2. Design goals

The litmus test Tyler set: **a test file should read as the policy.**

> *"Testing this endpoint, called with this user, should return this response."*

Goals, in priority order:

1. **Reads like the policy.** Each test case is one glanceable statement.
2. **Zero required machinery knowledge.** No callbacks to write for common
   assertions; no invariant classes; no manual ID management.
3. **Fluent builders everywhere.** Construction reads left-to-right,
   autocomplete-guided: `actor("user-a")…`.
4. **Machinery still available.** The existing primitives
   (`AuthorizationInvariant`, `HttpClient`, `FixtureSandbox`, reporters)
   remain public extension points underneath.
5. **Policy diffs reviewably.** Adding/changing an assumption changes one
   obvious line.

Non-goals: changing the execution engine, report formats, or redaction.

## 3. Proposed authoring surface

### 3.1 A fluent suite builder

```ts
import { apiContract } from "@auth-conformance/conformance";

export const contract = apiContract("ping-the-human", { appOrigin })
  .actor("anonymous", { authentication: "anonymous" })
  .actor("user-a", { bearer: ({ fixture }) => fixture.tokens.userA })
  .actor("user-b", { bearer: ({ fixture }) => fixture.tokens.userB });
```

Actors are registered once by name; cases reference them by name (string),
which keeps case declarations free of wiring and makes inventories greppable.

### 3.2 Endpoint descriptions instead of request-building closures

```ts
contract.endpoint("delete-device", {
  method: "DELETE",
  path: "/devices/:deviceId",
})
```

Path parameters become named slots resolved from resources at run time —
see 3.4. Custom request shaping remains possible via `.request((fixture) => …)`
for the rare case, but is not the default.

### 3.3 Expectations as declarative matchers

Replace `evaluate()` callbacks with composable matchers covering the 95%:

```ts
.expectStatus(403)
.expectError("DEVICE_NOT_FOUND")        // implies status + error-code envelope
.expectBody({ id: "…", nickname: "…" }) // deep subset match
.expectEmpty()                          // empty page/collection
.expectNoContent()
```

Each matcher produces a human-readable description used in reports — so the
report says *expected 403 DEVICE_NOT_FOUND* rather than dumping a diff.

### 3.4 The case statement

The centerpiece. One chain per authorization assumption:

```ts
contract.case("user-a cannot read user-b devices")
  .asUser("user-a")
  .get("/devices")
  .expectStatus(200)
  .expectBody([]);                       // list is scoped to the caller

contract.case("user-a cannot delete user-b device")
  .asUser("user-a")
  .delete("/devices/:deviceId", { deviceId: other.usersDevice })
  .expectError(403, "DEVICE_NOT_FOUND");

contract.case("anonymous is rejected everywhere")
  .asAnonymous()
  .post("/messages", { message: "hi" })
  .expectError(401, "UNAUTHENTICATED");
```

Reading the file top-to-bottom now *is* reading the authorization matrix.
This is the deliverable property: reviewers audit policy by reading tests.

### 3.5 Cross-cutting assumptions stay declarative: rules

Many assumptions apply to *families* of endpoints ("every authenticated
endpoint rejects anonymous"). Model them as rules, not copy-pasted cases:

```ts
contract.rule("all endpoints require authentication")
  .forEveryEndpoint()
  .whenCalledAs("anonymous")
  .expectError(401, "UNAUTHENTICATED");

contract.rule("users never see each other's devices")
  .forEndpoints({ tags: ["device"] })
  .whenCalledAs("user-a", { params: { deviceId: other.usersDevice } })
  .expectStatus(404);   // existence hidden, not 403-leaking
```

Rules expand into ordinary cases through the existing
`AuthorizationCaseExpander` (IDs auto-derived: `<rule-id>/<endpoint>/<actor>`),
so determinism, dedup detection, and reporting are preserved unchanged.

### 3.6 What stays under the hood

| Existing primitive | New role |
| --- | --- |
| `Actor`, `Operation`, `AuthorizationCase` | internal IR produced by builders |
| `AuthorizationInvariant` | advanced escape hatch; still exported |
| `AuthorizationSuite` / `AuthorizationRunner` | unchanged execution |
| `HttpClient`, `FixtureSandbox` ports | unchanged injection points |
| Reporters, redaction, coverage policy | unchanged |

The builder is a pure translation layer: `apiContract(...).cases()` returns
exactly the same `readonly AuthorizationCase[]` the old API produced. That
gives us a cheap migration proof: run both surfaces over the same invariants
and diff the expanded case IDs + expectations.

## 4. Migration plan (small, ordered steps)

1. **Add matchers module** (`expectations.ts`): `expectError`, `expectStatus`,
   `expectBody`, `expectNoContent`, `expectEmpty` as first-class exports.
   Zero risk; useful even to the old API.
2. **Add `apiContract` builder** producing existing IR. New code only;
   nothing removed. Old constructors stay deprecated-but-working.
3. **Add rules** on top of the builder (rule → case expansion).
4. **Golden equivalence harness**: express a sample of Ping-the-Human's 249
   cases in the new style (in this repo's dev tests, not app code) and assert
   identical expanded IDs and expectation descriptions vs. the originals.
5. Only after (4): mark verbose constructor paths `@deprecated`.

## 5. Open questions for Tyler

- **Naming:** `apiContract`? `authz`? `contract`? Also package rename candidates
  (`@auth-conformance/conformance` is stuttery — maybe just `@auth-conformance/core`).
- **Fixture typing:** the fluent API needs a fixture type parameter
  (`apiContract<MyFixture>(...)`) — acceptable, or do we want untyped-fixture mode?
- **Do rules need ordering guarantees between rule-derived and hand-written cases?**
  Current expander sorts by stable ID; probably fine to keep.
- **Should `expectBody` default to deep-subset matching** (asserted keys must
  match, extra keys ignored) or strict equality? Subset matches how people
  write policy; strict matches how people debug.
- **CLI:** once the API is human-friendly, a `auth-conformance run --openapi …`
  CLI (reusing `OpenApiCoveragePolicy`) would let any app adopt this without
  writing a runner. Worth doing in v0.2?

## 6. Summary

Keep the engine. Replace the authoring layer with a fluent builder whose
test files read as plain-language authorization policy:

```ts
contract.case("user-a cannot delete user-b device")
  .asUser("user-a")
  .delete("/devices/:deviceId", { deviceId: other.usersDevice })
  .expectError(403, "DEVICE_NOT_FOUND");
```

Everything else — sandboxes, runners, reports, redaction — already exists and
stays untouched.
