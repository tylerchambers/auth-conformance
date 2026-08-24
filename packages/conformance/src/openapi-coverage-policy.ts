import type { AuthorizationCase } from "./model.ts";
import type {
  CatalogOperation,
  CatalogSecurityMode,
  OperationClassification,
} from "./runner.ts";

/** Raised when the declared authorization matrix and public API inventory diverge. */
export class OpenApiCoverageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = OpenApiCoverageError.name;
  }
}

/** Validates complete, current, uniquely classified authorization coverage. */
export class OpenApiCoveragePolicy {
  validate<TFixture>(
    catalog: readonly CatalogOperation[],
    classifications: readonly OperationClassification[],
    cases: readonly AuthorizationCase<TFixture>[],
  ): void {
    const problems: string[] = [];
    const operations = this.uniqueOperations(catalog, problems);
    const declarations = this.uniqueClassifications(classifications, problems);
    const coveredOperationIds = new Set(
      cases.map(({ operation }) => operation.id),
    );

    for (const operationId of operations.keys()) {
      if (!declarations.has(operationId)) {
        problems.push(`missing classification: ${operationId}`);
      }
    }
    for (const operationId of declarations.keys()) {
      if (!operations.has(operationId)) {
        problems.push(`stale classification: ${operationId}`);
      }
    }
    for (const [operationId, classification] of declarations) {
      const operation = operations.get(operationId);
      if (operation === undefined) continue;
      const declaredSecurity = this.declaredSecurity(classification);
      if (
        declaredSecurity !== undefined &&
        declaredSecurity !== operation.security
      ) {
        problems.push(
          `security mode conflict: ${operationId} declares ${declaredSecurity} but OpenAPI documents ${operation.security}`,
        );
      }
      if (
        classification.mode === "excluded" &&
        classification.rationale.trim() === ""
      ) {
        problems.push(`empty exclusion rationale: ${operationId}`);
      }
      if (
        classification.mode !== "public" &&
        classification.mode !== "excluded" &&
        !coveredOperationIds.has(operationId)
      ) {
        problems.push(`operation without authorization case: ${operationId}`);
      }

      const operationCases = cases.filter(
        ({ operation: coveredOperation }) =>
          coveredOperation.id === operationId,
      );
      if (
        operationCases.some(
          ({ operation: coveredOperation }) =>
            coveredOperation.method !== operation.method ||
            coveredOperation.catalogPath !== operation.path,
        )
      ) {
        problems.push(
          `case target mismatch: ${operationId} expected ${operation.method} ${operation.path}`,
        );
      }
    }

    if (problems.length > 0) {
      throw new OpenApiCoverageError(problems.sort());
    }
  }

  private uniqueOperations(
    catalog: readonly CatalogOperation[],
    problems: string[],
  ): ReadonlyMap<string, CatalogOperation> {
    const operations = new Map<string, CatalogOperation>();
    for (const operation of catalog) {
      if (operations.has(operation.id)) {
        problems.push(`duplicate operation ID: ${operation.id}`);
      } else {
        operations.set(operation.id, operation);
      }
    }
    return operations;
  }

  private uniqueClassifications(
    classifications: readonly OperationClassification[],
    problems: string[],
  ): ReadonlyMap<string, OperationClassification> {
    const declarations = new Map<string, OperationClassification>();
    for (const classification of classifications) {
      if (declarations.has(classification.operationId)) {
        problems.push(
          `duplicate classification: ${classification.operationId}`,
        );
      } else {
        declarations.set(classification.operationId, classification);
      }
    }
    return declarations;
  }

  private declaredSecurity(
    classification: OperationClassification,
  ): CatalogSecurityMode | undefined {
    switch (classification.mode) {
      case "public":
        return "public";
      case "protocol":
        return classification.security;
      case "authenticated":
        return classification.security;
      case "excluded":
        return undefined;
    }
  }
}
