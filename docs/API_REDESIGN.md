# Authorization Conformance — Revised API Design

**Status:** revision 2, responding to Tyler's review of the first proposal
**Constraints (from review):**

- No backward compatibility. The package is unreleased; old constructors are a
  behavioral oracle, not an API target.
- Smallest, clearest public authoring surface possible.
- A test file reads directly as authorization policy.
- Routine cases need no callbacks and no manual IDs.
- Engine machinery is internal unless a concrete extension seam demands export.
- Strict vs subset body matching is explicit.
- Error envelopes are configured once per contract, not baked into the package.
- The actor/session lifecycle is fully specified (this revision's main job).

---

## 1. Naming

- Package: **`@auth-conformance/core`**
- Entry point: `import { authorizationContract } from "@auth-conformance/core"`

`authorizationContract` wins over `authzContract` because policy files are read
more often than they are written, "authz" requires knowing the jargon, and the
extra nine characters buy total obviousness for anyone seeing the file cold.

## 2. The complete public API

The entire intended export surface after redesign:

```ts
// Authoring
authorizationContract(options)          // -> AuthorizationContract
contract.case(description)              // -> CaseBuilder
contract.rule(description)              // -> RuleBuilder

// Expectations (methods on CaseBuilder / RuleBuilder terminal)
.expectStatus(n)
.expectBody(value)                      // deep equality, strict
.expectBodyContaining(subset)           // deep subset, explicit opt-in
.expectNoContent()
.expectEmpty()                          // empty array/page envelope
.expectError(status, code)              // uses the contract's error-envelope config
.expectThat(matcher)                    // escape hatch: custom Expectation

// Session/credential helpers
sessions.fromHeaders(headers | fn)      // static context
sessions.bearer(fn)                     // token resolved from session
sessions.cookie(name, value | fn)

// Reporting / execution entry (thin, stable)
runAuthorizationTests(contract, runnerOptions)
```

That is it. `Actor`, `Operation`, `ExpectedResponse`, `AuthorizationCase`,
`AuthorizationInvariant`, `AuthorizationSuite`, `AuthorizationRunner`,
reporters, redaction, and the coverage policy become **internal**. They remain
in the source tree — the engine is good — but nothing above is exported unless
a real use case appears that `.expectThat(...)` cannot express.

If we later need programmatic reporting (CI annotations etc.), we export one
narrow `Reporter` interface at that time, deliberately designed — not the
current `SuiteReport` object graph.

## 3. Actors and sessions — the fully specified model

This was the biggest open question. Here is the model.

### 3.1 Concepts, in order of abstraction

```
Fixture        the world the tests run against (typed, inferred)
Session        authenticated request context for one principal:
               headers + cookies + arbitrary identity metadata
Actor          a *named role in the policy* that resolves to a Session
Credential     the mechanism that turns a Session into outgoing
               request headers/cookies (bearer token, cookie, api key…)
```

### 3.2 Answers to the eight questions

**Q1/Q2 — what is registered under `"user-a"`?**
A `SessionFactory<Fixture>`: an async function from the current fixture to a
`Session`. Not a token provider, not a login function — though both are easy to
express *as* one. The session is deliberately generalized:

```ts
type Session = {
  readonly id: string;                     // stable, for reports/logs
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string | boolean>>;
};
```

Everything the transport layer needs to impersonate the principal lives here.
Nothing about *how* authentication happened does.

**Q3 — who creates the user and authenticates them?**
Fixture/sandbox setup owns *provisioning* (creating users, seeding state).
The session factory owns *authentication* (turning provisioned identity into
credentials). Actor registration only names the role and points at its
factory. This three-way split keeps each concern in the layer that can answer
for it:

```ts
// sandbox: creates real users in a scratch database
const sandbox = createPostgresSandbox({ createFixture });

// registration: how a provisioned user proves who they are
.actor("user-a", async ({ fixture }) => ({
  id: "user-a",
  headers: { authorization: `Bearer ${fixture.sessions.userA}` },
}))
```

**Q4 — is session acquisition async?**
Yes. Factories are `(context) => Session | Promise<Session>`. Login flows are
inherently I/O-bound; pretending otherwise forces hacks.

**Q5 — when is a session acquired?**
Lazily on first use, then cached per case. Concretely:

- The sandbox installs fresh fixture state before every case (existing
  behavior, preserved).
- Within a case, `.as("user-a")` resolves the session on first HTTP call and
  reuses it for the rest of that case.
- Sessions are **not** cached across cases — the fixture resets, so any cached
  credential could be stale. Per-case acquisition is the only correct default.

Cost note: this means N cases using `"user-a"` perform N logins against the
sandbox. That is acceptable because sandboxes are local/fast by definition;
if a suite ever needs cross-case reuse, that is an explicit opt-in later
(`.sessionScope("suite")`), never the silent default — stale credentials are
the worst kind of false-pass.

**Q6 — beyond bearer tokens?**
Yes — that is why `Session` carries headers *and* cookies rather than a
`token` field. Provided helpers cover common mechanisms without changing the
model:

```ts
.actor("user-a", sessions.bearer(({ fixture }) => fixture.tokens.userA))
.actor("mobile-app", sessions.apiKey(({ fixture }) => fixture.keys.mobile))
.actor("browser", sessions.cookies(async ({ fixture }) => {
  return loginAndExtractCookies(fixture);   // real browser-flow login
}))
.actor("mtls-client", sessions.fromHeaders(() => ({ "x-client-cert-fp": FP })))
```

mTLS itself happens below the library (at the HTTP client adapter); the actor
only contributes whatever request-visible identity the service checks.

**Q7 — refresh/mutation mid-run?**
A session may expose `refresh(context): Promise<Session>`. When the executor
receives a `401`/credential-expired signal *and* the case has not yet asserted
its expected status, it calls `refresh()` once and retries. One retry, bounded,
and only when the case's expectation isn't simply "401". If a policy case
exists specifically to test expired-token rejection, register the actor with
`refresh: undefined` (or a factory returning already-stale credentials) — the
absence is explicit, not accidental.

**Q8 — fixture typing without noise?**
Inference from the sandbox/factory, per §5. No generics at call sites.

### 3.3 Anonymous

Anonymous is just an actor whose session contributes nothing:

```ts
.actor("anonymous", sessions.anonymous())
```

One general `.as(...)` concept; no special casing in the case builder.

## 4. Cases: direct operations, no endpoint registry

**Decision: Design A — cases declare HTTP operations directly.**

Design B (first-class endpoint objects) was rejected because its benefits are
already covered better elsewhere:

- **Rules targeting endpoint families** → derive families from OpenAPI via the
  existing coverage machinery (`rule().forOperations({ tags })` matches OpenAPI
  operation IDs/tags). The OpenAPI document is already the inventory source of
  truth in Tyler's stack; a second hand-maintained registry would drift.
- **Reuse of a path across cases** → paths are short strings; repeating
  `/devices/:deviceId` across three cases costs less than an indirection layer.
- **Tags/grouping** → descriptions plus generated IDs serve reporting.

So there is exactly one way to say which endpoint is called, and it appears
right in the case statement. Zero indirection between reader and policy.

```ts
contract.case("user-a cannot delete user-b device")
  .as("user-a")
  .delete("/devices/:deviceId", { params: { deviceId: ... } })
  .expectError(403, "DEVICE_NOT_FOUND");
```

Path parameters: any `:name` segment must be supplied in `params`; missing or
unused params are type errors. Query/body/headers are plain optional fields.
A raw-escape exists (`.request((fixture) => HttpRequest)`) but is expected to
be rare enough to stay undiscoverable-by-default.

## 5. Contract construction and fixture typing

```ts
const contract = authorizationContract({
  name: "ping-the-human",
  baseUrl: () => process.env.AUTHORIZATION_BASE_URL,   // resolved at run time
  error: {                                             // error envelope, once
    code: (body: unknown) => parseErrorEnvelope(body).code,
  },
  fixture: createFixture,                              // Fixture inferred HERE
})
  .actor("anonymous", sessions.anonymous())
  .actor("user-a", sessions.bearer(({ fixture }) => fixture.tokens.userA))
  .actor("user-b", sessions.bearer(({ fixture }) => fixture.tokens.userB));
```

`fixture: createFixture` is `(deps) => Promise<Fixture>`; TypeScript infers
`Fixture` from it and threads it through every actor factory, case param
expression, and expectation. Authors never write `authorizationContract<MyFixture>`.
(Inference works because options are a single object parameter — the classic
inference site pattern.) If some exotic setup defeats inference, the generic
remains available; type safety is never traded away for ergonomics.

### Error envelopes

`expectError(403, "DEVICE_NOT_FOUND")` means: status equals 403 AND
`contract.error.code(body)` equals `"DEVICE_NOT_FOUND"`. Without `error`
configured, `expectError` requires status only — and the code argument is a
compile-time unavailable overload, so nobody assumes an envelope shape the
package invented. Application-specific JSON structure lives entirely in the
consumer's one-line configuration.

## 6. Expectations semantics

| Matcher | Meaning |
| --- | --- |
| `.expectStatus(n)` | response status === n |
| `.expectBody(v)` | deep equality — extra fields FAIL |
| `.expectBodyContaining(s)` | deep subset — asserted keys match, extras ignored |
| `.expectNoContent()` | status 204 and empty body |
| `.expectEmpty()` | empty collection (array or page envelope) |
| `.expectError(status, code)` | status + configured envelope code |
| `.expectThat(matcher)` | custom escape hatch |

Strictness defaults live in the matcher *names*, not in flags. Reports render
each matcher's intent ("expected body containing {id, nickname}") rather than
dumping diffs, so failure output reads as policy language too.

## 7. Rules — constrained and boring

A rule is a policy statement over a family of operations that expands into
ordinary cases through the existing deterministic expander. Deliberately
narrow, to avoid inventing a second language:

- Selects operations by OpenAPI-derived criteria (operation ID list, tag) —
  not arbitrary predicates.
- One actor binding, one optional fixed parameterization, one expectation.
- No composition, no conditionals, no loops-within-rules. If a rule needs
  those, it should be several rules or hand-written cases.

```ts
contract.rule("every endpoint rejects anonymous callers")
  .forAllOperations()
  .as("anonymous")
  .expectError(401, "UNAUTHENTICATED");

contract.rule("device data never leaks across users")
  .forOperations({ ids: ["list-devices", "get-device", "update-device"] })
  .as("user-a", { params: { deviceId: ... } })
  .expectStatus(404);
```

Generated IDs: `<normalized-description>/<operation-id>/<actor>`, sorted with
the existing stable comparator. Collision with a hand-written case fails the
build loudly; `.id("...")` remains the explicit disambiguation hatch. No
ordering guarantee between rule-derived and hand-authored cases beyond stable
sort — accepted per review.

## 8. IDs out of sight

Descriptions become deterministic internal IDs (slugified description +
actor + operation discriminator). Authors never see an ID requirement; the
`.id()` hatch exists but should be nearly unused. Reports show the human
description prominently and the generated ID secondarily.

## 9. Complete example

One file that shows the whole authoring model:

```ts
import { authorizationContract, sessions } from "@auth-conformance/core";
import { createSandbox } from "./sandbox.ts";

const sandbox = createSandbox(); // installs scratch DB per case; typed Fixture

const contract = authorizationContract({
  name: "ping-the-human",
  baseUrl: () => process.env.AUTHORIZATION_BASE_URL!,
  error: { code: (body) => (body as { error: { code: string } }).error.code },
  fixture: sandbox.createFixture,            // Fixture type inferred from here
})
  .actor("anonymous", sessions.anonymous())
  .actor("user-a", sessions.bearer(({ fixture }) => fixture.tokens.userA))
  .actor("user-b", sessions.bearer(({ fixture }) => fixture.tokens.userB));

// ── Hand-written policy cases ────────────────────────────────────────────

contract.case("anonymous cannot send a message")
  .as("anonymous")
  .post("/messages", { body: { message: "ping" } })
  .expectError(401, "UNAUTHENTICATED");

contract.case("user-a sees only their own devices")
  .as("user-a")
  .get("/devices")
  .expectStatus(200)
  .expectBodyContaining({ devices: [{ nickname: "olive-tablet" }] });

contract.case("user-a cannot delete user-b device")
  .as("user-a")
  .delete("/devices/:deviceId", { params: { deviceId: ({ fixture }) => fixture.devices.userB.id } })
  .expectError(404, "DEVICE_NOT_FOUND");     // existence hidden, not 403

// ── Cross-cutting rules ──────────────────────────────────────────────────

contract.rule("every endpoint rejects anonymous callers")
  .forAllOperations()
  .as("anonymous")
  .expectError(401, "UNAUTHENTICATED");

export const authorizationTests = contract.build();
```

Reading top to bottom: who exists, how they authenticate, what each principal
may and may not do, and which assumptions hold everywhere. That is the whole
point.

Execution stays one call inside the app's test files:

```ts
await runAuthorizationTests(authorizationTests, { sandbox });
```

## 10. Plan of work (no deprecation steps)

1. Implement the new authoring surface over the existing engine internals
   (rename internals freely — nothing is public anymore).
2. Rewrite a representative cross-section of the Ping-the-Human suite
   (~30 of 249 cases spanning tracer/admin/protocol invariants) in dev tests
   as the oracle harness: compare expanded case sets, requests issued,
   outcomes, redaction, and report text against the old suite.
3. Rewrite remaining cases; port the suite into the app repo consuming the
   published workspace package.
4. Delete obsolete authoring abstractions outright. Engine pieces stay
   internal until a concrete seam justifies exporting one.

CLI deferred, as agreed — it becomes a thin wrapper over `contract.build()`
once this stabilizes.

## 11. Still open

- Exact shape of the OpenAPI-derived rule selection (`forOperations({ ids | tags })`
  vs reusing the coverage policy's classification modes).
- Whether `metadata` on `Session` earns its keep or gets cut until needed
  (leaning: cut; add when a consumer needs it).
