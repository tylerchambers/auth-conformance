# Slice 1: Authoring surface over the existing engine

**Handoff scope for one worker.** Everything needed is in this repo; do not
modify `agent-pager-cloud`. The design contract is
[`docs/API_REDESIGN.md`](./API_REDESIGN.md) — it is final; implement what it
says, flag deviations rather than improvising.

## Goal

Implement the public authoring API described in §2 of the design doc on top of
the existing engine in `packages/conformance/src/`. No behavior change to the
engine's execution semantics. All 31 existing tests must stay green throughout.

The core abstraction being implemented:

> actor name → per-case async session factory → headers/cookies → exactly one request → expectation

## In scope (this slice only)

New module `packages/conformance/src/authoring.ts` (plus tests under
`packages/conformance/tests/`) exporting exactly the §2 surface:

1. `authorizationContract(options)` — accepts `name`, `baseUrl` (thunk),
   `error: { code(body) }`, `lifecycle: FixtureLifecycle<F>`,
   `operations?: OperationInventory`. `Fixture` type inferred from
   `lifecycle.create`. Returns builder with `.actor(...)`, `.case(...)`,
   `.rule(...)`, and terminal `.build()`.
2. Session helpers: `sessions.anonymous()`, `.bearer(x | fn)`,
   `.apiKey(headerName, x | fn)`, `.cookies(x | fn)`, `.fromHeaders(x | fn)` —
   all are constructors over `SessionFactory<F>` returning `{ headers?, cookies? }`.
   Async factories supported (`Session | Promise<Session>`).
3. `CaseBuilder`: `.as(actorName)`, HTTP verb methods (`.get/.post/.put/
   .patch/.delete/.head(path, request?)`) with typed `:param` slots via
   `params`, then exactly one terminal expectation from:
   `.expectStatus`, `.expectBody` (strict deep equal), `.expectBodyContaining`
   (deep subset), `.expectNoContent`, `.expectError(status, code?)`,
   `.expectThat(assertion callback)` — the callback seam defined in §6.
4. `RuleBuilder`: `.forAllOperations()` / `.forOperations({ ids } | { tags })`,
   actor binding, one expectation; expands to ordinary cases through the
   existing expander with deterministic IDs
   `<slug(description)>/<operation-id>/<actor>`. Unknown ID/tag ⇒ loud error.
5. Generated case IDs: slugified description + actor + operation discriminator;
   collisions throw; optional explicit `.id(...)` escape hatch.
6. `contract.build()` returns the internal case list (existing IR).
7. `runAuthorizationTests(contract)` — drives the existing runner/sandbox
   lifecycle: fresh `create()` per case, one request per case (NO retries, NO
   refresh), dispose after each case.

## Out of scope

- CLI, reporters redesign, redaction changes.
- Deleting old internals this slice — they stay internal/private; deletion is a
  later slice once the oracle harness (Slice 2) exists.
- Any app-repo integration.

## Existing engine pieces to reuse (do not rewrite)

`packages/conformance/src/`: `model.ts` (Actor/Operation/AuthorizationCase),
`runner.ts` (expander, suite, executor), `ordering.ts` (stable sort),
`redaction.ts`. Treat them as internal; you may reorganize/rename inside the
package as long as the package's single public export surface matches §2.

## Acceptance criteria

1. New authoring tests cover: contract construction + fixture inference,
   each session helper, each expectation matcher (strict vs containing
   distinction explicitly tested), param path resolution (missing/extra params
   rejected at compile time where feasible), rule expansion determinism +
   unknown-ID/tag failure, ID collision failure, exactly-one-request guarantee
   (count requests via a fake HttpClient), lifecycle order
   (create → request → dispose per case), lazy per-case session acquisition
   (session factory called once per case, never across cases).
2. All pre-existing 31 tests still pass unmodified.
3. `bun run typecheck && bun run format:check && bun test packages` all green.
4. The package's public exports match the §2 list — nothing else exported.
5. One commit (or small series) with messages describing intent; push to a
   branch `slice-1-authoring-surface` (do NOT push directly to `main`).

## Verification commands

```bash
cd ~/dev/github.com/tylerchambers/auth-conformance
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test packages
```

## Reassess / escalate

If the design doc conflicts with something the engine cannot express cleanly,
stop and report back rather than expanding scope — that decision belongs to Tyler.
