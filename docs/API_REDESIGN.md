# Authorization Conformance — Revised API Design

**Status:** revision 3, responding to Tyler's follow-up review
**Guiding principle:** the package is unreleased; delete every abstraction that
is merely plausible rather than currently necessary. The initial API is the
cheapest point we will ever have to keep it small.

The abstraction we are converging on:

> **actor name → per-case async session factory → headers/cookies → exactly one request → expectation**

with fixture lifecycle orthogonal and explicit.

---

## 1. Naming

- Package: **`@auth-conformance/core`**
- Entry point: `import { authorizationContract } from "@auth-conformance/core"`

`authorizationContract` wins over `authzContract`: policy files are read more
often than written, "authz" requires jargon, and nine extra characters buy
total obviousness for anyone seeing the file cold.

## 2. The complete public API

The entire intended export surface after redesign:

```ts
// Entry
authorizationContract(options)              // -> AuthorizationContract

// Case authoring
contract.case(description)                  // -> CaseBuilder
contract.rule(description)                  // -> RuleBuilder

// CaseBuilder terminal expectations
.expectStatus(n)
.expectBody(value)                          // deep equality, strict
.expectBodyContaining(subset)               // deep subset, explicit opt-in
.expectNoContent()
.expectError(status, code?)                 // uses contract's error-envelope config
.expectThat(matcher)                        // escape hatch: custom Expectation

// CaseBuilder operation declaration
.get(path, request?)
.post(path, request?)
.put(path, request?)
.patch(path, request?)
.delete(path, request?)
.head(path, request?)

// Session helpers — all convenience constructors over SessionFactory
sessions.anonymous()                        // contributes no headers/cookies
sessions.bearer(token | fn)
sessions.apiKey(headerName, key | fn)
sessions.cookies(cookies | fn)
sessions.fromHeaders(headers | fn)

// Rule selection (boring, explicit)
.forAllOperations()
.forOperations({ ids: [...] } | { tags: [...] })

// Execution entry
runAuthorizationTests(contract)             // sandbox comes from the contract
```

That is everything. `Actor`, `Operation`, `ExpectedResponse`,
`AuthorizationCase`, `AuthorizationInvariant`, suites, runners, reporters,
redaction, coverage policy — all internal. Nothing is exported unless a real
use case appears that `.expectThat(...)` cannot express.

Helper naming settled: **`cookies`** (plural, matches `headers`) and
**`apiKey(headerName, …)`** rather than an assumed header. §2 is exhaustive;
if implementation reveals a missing helper, it gets added *to this list* at
the same time it gets added to the code.

## 3. Sessions

### 3.1 The model, simplified per review

Three concepts, not four:

```
Fixture    typed world the tests run against
Session    plain request-authentication context:
           { headers?, cookies? }
Actor      named policy role that resolves to a Session via a factory
```

**`Credential` is deleted as a concept.** The session already contains its
outgoing headers/cookies; `sessions.*` helpers are just conveniences that
build `SessionFactory` functions. There was never a second layer.

```ts
type Session = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
};

type SessionFactory<Fixture> =
  (context: { readonly fixture: Fixture }) => Session | Promise<Session>;
```

No `Session.id` — the actor name already carries the reporting identity.
No `metadata` — cut until a consumer demonstrates the need.

### 3.2 Lifecycle decisions

- **Async:** yes. Factories may return `Session | Promise<Session>`.
- **When:** lazily on first HTTP call within a case; cached for the rest of
  that case only. Never across cases — the fixture resets per case, so any
  cross-case credential could be stale, and stale credentials are silent
  false-passes.
- **Refresh: none. Cut entirely.** A case makes exactly one request and
  asserts on exactly what came back. The runner never converts one request
  into two based on the response. Ordinary freshness is handled by per-case
  acquisition; testing expired/stale credentials is represented explicitly by
  a dedicated actor whose factory returns already-stale credentials:

  ```ts
  .actor("user-a-with-expired-token",
         sessions.bearer(({ fixture }) => fixture.expiredTokens.userA))
  ```

- **Anonymous:** just another actor — `sessions.anonymous()` produces `{}`.
  One general `.as(...)`, no special cases.

### 3.3 Who provisions users?

Sandbox/fixture setup provisions (creates users, seeds state); the session
factory authenticates (turns provisioned identity into headers/cookies);
actor registration only names the role. Test authors never see any of this
from inside a case — `.as("user-a")` is all they write.

## 4. Cases: direct operations

Cases declare HTTP operations directly; there is no endpoint registry. Path
parameters (`:name`) must be supplied via `params` and are type-checked;
missing/unused params fail compilation. A raw `.request(fn)` escape exists
but stays rare by design.

Rules select families explicitly — OpenAPI operation IDs or tags, nothing
cleverer:

```ts
contract.rule("every endpoint rejects anonymous callers")
  .forAllOperations()
  .as("anonymous")
  .expectError(401, "UNAUTHENTICATED");
```

Generated case IDs derive deterministically from description + actor +
operation; collisions fail loudly; `.id(...)` is the disambiguation hatch.
Stable sort only — no second ordering guarantee.

## 5. Contract construction, fixture typing, error envelopes

```ts
const contract = authorizationContract({
  name: "ping-the-human",
  baseUrl: () => process.env.AUTHORIZATION_BASE_URL!,
  error: { code: (body) => parseEnvelope(body).code },  // configured ONCE
  fixture: sandbox.lifecycle.create,   // Fixture inferred HERE
})
  .actor("anonymous", sessions.anonymous())
  .actor("user-a", sessions.bearer(({ fixture }) => fixture.tokens.userA))
  .actor("user-b", sessions.bearer(({ fixture }) => fixture.tokens.userB));
```

`fixture: createFixture` infers `Fixture` through every actor factory, param
expression, and expectation — authors never write a generic argument.

### Error envelopes

`expectError(403, "DEVICE_NOT_FOUND")` = status 403 AND
`contract.error.code(body) === "DEVICE_NOT_FOUND"`. With no `error` config,
only the status-only overload typechecks — the package never invents an
envelope shape.

## 6. Expectations

| Matcher | Meaning |
| --- | --- |
| `.expectStatus(n)` | response status === n |
| `.expectBody(v)` | strict deep equality; extra fields FAIL |
| `.expectBodyContaining(s)` | deep subset; asserted keys match, extras ignored |
| `.expectNoContent()` | status 204 and empty body |
| `.expectError(status, code?)` | status + configured envelope code |
| `.expectThat(matcher)` | custom escape hatch |

**`expectEmpty()` is removed.** "Empty page envelope" was quietly becoming
application-specific magic. An empty collection is simply
`.expectBody([])` — strict, obvious, zero hidden shapes. If page-envelope
matching is ever needed, it belongs in consumer-side `.expectThat(matcher)`
or a future explicitly-named matcher, not in a vague core verb.

Reports render each matcher's intent ("expected body equal to {…}") so
failure output reads as policy language too.

## 7. Fixture/sandbox lifecycle — one owner

Per review: the previous example passed fixture concerns in twice. Fixed by
making the **sandbox own the whole lifecycle** and passing it to the contract
once:

```ts
type FixtureLifecycle<Fixture> = {
  create(): Promise<Fixture>;                              // fresh per case
  reset?(fixture: Fixture): Promise<void>;                 // optional fast path
  dispose(fixture: Fixture): Promise<void>;                // cleanup
};
```

- The contract receives `lifecycle: sandbox.lifecycle` (which also supplies
  `create` for fixture type inference — one object, two roles, no duplication).
- `runAuthorizationTests(contract)` takes **nothing else**. It drives the
  lifecycle through the contract: install before each case, run the case's
  exactly-one request, assert, then dispose/reset. There is no separate
  runner-level sandbox parameter at all, so the double-passing failure mode
  cannot occur.

Answers, plainly:

- **Who creates the fixture?** The lifecycle's `create`, invoked by the runner,
  once per case.
- **Who resets/disposes?** The runner, via the same lifecycle object — `reset`
  when provided, otherwise fresh `create`.
- **What does `runAuthorizationTests` need beyond the contract?** Nothing.

Apps still invoke it inside their ordinary test files:

```ts
await runAuthorizationTests(authorizationTests);
```

## 8. Complete example

```ts
import { authorizationContract, sessions } from "@auth-conformance/core";
import { sandbox } from "./sandbox.ts"; // owns scratch DB lifecycle

const contract = authorizationContract({
  name: "ping-the-human",
  baseUrl: () => process.env.AUTHORIZATION_BASE_URL!,
  error: { code: (body) => (body as { error: { code: string } }).error.code },
  lifecycle: sandbox.lifecycle,          // Fixture inferred from here
})
  .actor("anonymous", sessions.anonymous())
  .actor("user-a", sessions.bearer(({ fixture }) => fixture.tokens.userA))
  .actor("user-b", sessions.bearer(({ fixture }) => fixture.tokens.userB))
  .actor("user-a-stale-token",
         sessions.bearer(({ fixture }) => fixture.expiredTokens.userA));

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
  .delete("/devices/:deviceId",
          { params: { deviceId: ({ fixture }) => fixture.devices.userB.id } })
  .expectError(404, "DEVICE_NOT_FOUND");     // existence hidden, not 403-leak

contract.case("expired tokens are rejected outright")
  .as("user-a-stale-token")                  // explicit actor, no magic refresh
  .get("/devices")
  .expectError(401, "UNAUTHENTICATED");

// ── Cross-cutting rule ───────────────────────────────────────────────────

contract.rule("every endpoint rejects anonymous callers")
  .forAllOperations()
  .as("anonymous")
  .expectError(401, "UNAUTHENTICATED");

export const authorizationTests = contract.build();
```

Reading top to bottom: who exists, how each principal authenticates, what
they may and may not do, which assumptions hold everywhere. One file, whole
policy.

## 9. Plan of work

1. Implement the authoring surface over existing engine internals; rename or
   delete internals freely — nothing above is public anymore.
2. Rewrite a representative cross-section of the Ping-the-Human suite (~30 of
   249 cases spanning tracer/admin/protocol) in dev tests as the behavioral
   oracle: compare expanded case sets, requests issued (count included — the
   one-request guarantee is itself oracle-checked), outcomes, redaction,
   report text.
3. Rewrite remaining cases; consume the workspace package from the app repo.
4. Delete obsolete authoring abstractions outright.

CLI remains deferred until the API stabilizes.
