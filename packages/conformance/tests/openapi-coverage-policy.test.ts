import { describe, expect, it } from "bun:test";
import {
  Actor,
  AuthorizationCase,
  type AuthorizationInvariant,
  type CatalogOperation,
  ExpectedResponse,
  OpenApiCoveragePolicy,
  Operation,
  type OperationClassification,
} from "../src/index.ts";

const actor = new Actor<undefined>({
  name: "anonymous",
  authentication: "anonymous",
});
const expected = new ExpectedResponse({
  description: "success",
  evaluate: () => [],
});

class Cases implements AuthorizationInvariant<undefined> {
  readonly id = "cases";

  constructor(private readonly operationIds: readonly string[]) {}

  expand(): readonly AuthorizationCase<undefined>[] {
    return this.operationIds.map((operationId) => {
      const documented = requiredCatalogOperation(operationId);
      return new AuthorizationCase({
        id: `case.${operationId}`,
        actor,
        operation: new Operation({
          id: operationId,
          method: documented.method,
          catalogPath: documented.path,
          buildRequest: () => ({ path: documented.path }),
        }),
        expectedResponse: expected,
      });
    });
  }
}

const catalog: readonly CatalogOperation[] = [
  { id: "ready", method: "GET", path: "/ready", security: "public" },
  { id: "me", method: "GET", path: "/v1/me", security: "browser-or-bearer" },
  { id: "claim", method: "POST", path: "/device", security: "public" },
];
const classifications: readonly OperationClassification[] = [
  { operationId: "ready", mode: "public" },
  { operationId: "me", mode: "authenticated", security: "browser-or-bearer" },
  { operationId: "claim", mode: "protocol", security: "public" },
];

describe("OpenApiCoveragePolicy", () => {
  it("accepts a complete catalog with covered secured and protocol operations", () => {
    const policy = new OpenApiCoveragePolicy();

    expect(() =>
      policy.validate(
        catalog,
        classifications,
        new Cases(["me", "claim"]).expand(),
      ),
    ).not.toThrow();
  });

  it("reports missing classifications before fixture execution", () => {
    const policy = new OpenApiCoveragePolicy();

    expect(() =>
      policy.validate(
        catalog,
        classifications.slice(0, 2),
        new Cases(["me"]).expand(),
      ),
    ).toThrow("missing classification: claim");
  });

  it("rejects stale and duplicate declarations", () => {
    const policy = new OpenApiCoveragePolicy();
    const invalid = [
      ...classifications,
      { operationId: "removed", mode: "public" } as const,
      {
        operationId: "me",
        mode: "authenticated",
        security: "browser",
      } as const,
    ];

    expect(() =>
      policy.validate(catalog, invalid, new Cases(["me", "claim"]).expand()),
    ).toThrow("duplicate classification: me; stale classification: removed");
  });

  it("rejects duplicate operation IDs and documented security conflicts", () => {
    const policy = new OpenApiCoveragePolicy();
    const invalidCatalog = [
      ...catalog,
      {
        id: "me",
        method: "POST",
        path: "/duplicate",
        security: "browser",
      } as const,
    ];
    const invalidClassifications = classifications.map((classification) =>
      classification.operationId === "me"
        ? ({
            operationId: "me",
            mode: "authenticated",
            security: "browser",
          } as const)
        : classification,
    );

    expect(() =>
      policy.validate(
        invalidCatalog,
        invalidClassifications,
        new Cases(["me", "claim"]).expand(),
      ),
    ).toThrow(
      "duplicate operation ID: me; security mode conflict: me declares browser but OpenAPI documents browser-or-bearer",
    );
  });

  it("requires every authenticated or protocol operation to have a case", () => {
    const policy = new OpenApiCoveragePolicy();

    expect(() => policy.validate(catalog, classifications, [])).toThrow(
      "operation without authorization case: claim; operation without authorization case: me",
    );
  });

  it("rejects cases that declare the wrong documented method or path", () => {
    const wrongMethod = new AuthorizationCase({
      id: "case.me.wrong-method",
      actor,
      operation: new Operation({
        id: "me",
        method: "POST",
        catalogPath: "/v1/me",
        buildRequest: () => ({ path: "/v1/me" }),
      }),
      expectedResponse: expected,
    });
    const wrongPath = new AuthorizationCase({
      id: "case.claim.wrong-path",
      actor,
      operation: new Operation({
        id: "claim",
        method: "POST",
        catalogPath: "/wrong",
        buildRequest: () => ({ path: "/wrong" }),
      }),
      expectedResponse: expected,
    });

    expect(() =>
      new OpenApiCoveragePolicy().validate(catalog, classifications, [
        wrongMethod,
        wrongPath,
      ]),
    ).toThrow(
      "case target mismatch: claim expected POST /device; case target mismatch: me expected GET /v1/me",
    );
  });

  it("rejects a mislabeled case even when another case covers the operation", () => {
    const correctCase = new Cases(["me"]).expand()[0];
    if (correctCase === undefined) throw new Error("missing correct test case");
    const wrongCase = new AuthorizationCase({
      id: "case.me.wrong-path",
      actor,
      operation: new Operation({
        id: "me",
        method: "GET",
        catalogPath: "/wrong",
        buildRequest: () => ({ path: "/wrong" }),
      }),
      expectedResponse: expected,
    });

    expect(() =>
      new OpenApiCoveragePolicy().validate(
        catalog.slice(0, 2),
        classifications.slice(0, 2),
        [correctCase, wrongCase],
      ),
    ).toThrow("case target mismatch: me expected GET /v1/me");
  });

  it("permits a non-empty justified exclusion without a case", () => {
    const policy = new OpenApiCoveragePolicy();
    const excluded: readonly OperationClassification[] = [
      requiredClassification(0),
      {
        operationId: "me",
        mode: "excluded",
        rationale: "Dependency-owned setup surface",
      },
      requiredClassification(2),
    ];

    expect(() =>
      policy.validate(catalog, excluded, new Cases(["claim"]).expand()),
    ).not.toThrow();
    expect(() =>
      policy.validate(
        catalog,
        [
          requiredClassification(0),
          { operationId: "me", mode: "excluded", rationale: "   " },
          requiredClassification(2),
        ],
        new Cases(["claim"]).expand(),
      ),
    ).toThrow("empty exclusion rationale: me");
  });
});

function requiredClassification(index: number): OperationClassification {
  const classification = classifications[index];
  if (classification === undefined) {
    throw new Error(`missing test classification at index ${index}`);
  }
  return classification;
}

function requiredCatalogOperation(operationId: string): CatalogOperation {
  const operation = catalog.find(({ id }) => id === operationId);
  if (operation === undefined) {
    throw new Error(`missing test operation ${operationId}`);
  }
  return operation;
}
