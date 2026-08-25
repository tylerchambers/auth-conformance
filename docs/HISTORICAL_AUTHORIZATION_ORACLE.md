# Historical authorization behavioral-oracle parity

## Scope

This repository contains a dependency-free parity slice for 30 historical authorization cases:

- 10 tracer cases covering account, device, ping, push, entitlement, and session boundaries
- 10 administrator cases covering authentication, administrator capability, Origin enforcement, invitation state, and beta-access outcomes
- 10 device-protocol cases covering issuance, claim, approval, denial, polling, redemption, ownership, and Origin enforcement

The checked-in golden artifact is
[`packages/conformance/tests/fixtures/historical-authorization-oracle.json`](../packages/conformance/tests/fixtures/historical-authorization-oracle.json).
Equivalent fluent declarations are test-only in
[`packages/conformance/tests/support/historical-oracle-contract.ts`](../packages/conformance/tests/support/historical-oracle-contract.ts).
They use only the four-symbol public package API and deliberately do not broaden it for application-specific behavior.

## Provenance

The source was inspected read-only at immutable commit
`a87cf00af3ab2792ae5eb7382aaae3326ad524b0` in
`tylerchambers/agent-pager-cloud` after fetching its `origin/main` on 2026-08-24.
The historical suite declared 249 stable cases and sorted expanded cases by case ID.
The fixture records the exact source paths used for tracer, administrator, protocol, actor, operation, and expectation behavior.

Agent Pager Cloud is historical source material only. This test creates no runtime, build, package, network, or repository dependency on it and makes no recommendation or plan to adopt or migrate to it.

## Selection method

The slice is balanced rather than exhaustive. Cases were chosen for stable IDs and representative coverage of:

- anonymous, browser-session, revoked-session, administrator, non-administrator, and CLI-bearer actors;
- exact methods, paths, JSON bodies, Origin headers, cookies, bearer headers, and idempotency headers;
- authentication and validation precedence;
- owner-versus-foreign-resource behavior;
- application and OAuth error families;
- successful, denied, not-found, accepted, and no-content outcomes.

All credentials and sensitive resources in the artifact are synthetic placeholders. No historical or production credential is copied.

## What the tests prove

The deterministic suite proves that:

- all 30 explicit IDs and their lexicographic execution order match the golden artifact;
- each declaration maps the recorded actor to the recorded endpoint and expected result;
- the runner produces the exact recorded primary request method, path, body, and synthetic authentication headers/cookies;
- each case creates one fresh fixture, acquires one fresh asynchronous session, sends exactly one primary HTTP request, and disposes that fixture once;
- recorded responses satisfy one of four explicit oracle modes: strict status/body equality, OAuth status/code with an optional description, status-only, or no-content; and
- transport failures and retained reports redact the selected bearer and browser-cookie credential values.

The tests use an in-memory recording HTTP client and deterministic lifecycle. They require no network, database, Docker daemon, clock, or external service.

## What parity does not prove

This is behavioral-oracle parity, not byte-for-byte implementation equivalence. It does not prove:

- parity for the other 219 historical cases;
- application internals, database state, middleware composition, cryptographic validity, or a live deployment;
- the historical postcondition observation requests or every follow-up in connected protocol journeys;
- exact rich success-response equality when the historical case used a custom evaluator or status-only expectation; or
- that unsafe or inconsistent historical behavior should be preserved in a consumer.

Notable historical discrepancies remain documented rather than copied into the package API:

- one successful claim returned a user code that the historical fixture classified as sensitive elsewhere;
- ping acceptance checked status only;
- some ordering cases intentionally combined several invalid inputs to prove precedence;
- cleanup was invoked at two layers and depended on memoized idempotence; and
- some page checks asserted presence rather than full equality.

Parameterized OpenAPI rules remain fail-closed. None of the selected explicit cases requires changing that behavior.
