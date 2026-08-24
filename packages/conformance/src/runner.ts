import {
  type Actor,
  type AuthorizationCase,
  AuthorizationCaseExpander,
  type AuthorizationInvariant,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  type Operation,
  type ResponseMismatch,
} from "./model.ts";
import { OpenApiCoveragePolicy } from "./openapi-coverage-policy.ts";
import { SensitiveValueRedactor } from "./redaction.ts";

export type FailureCategory =
  | "policy-mismatch"
  | "malformed-response"
  | "transport-failure"
  | "fixture-failure"
  | "framework-defect";

export type AuthorizationFailure = {
  readonly category: FailureCategory;
  readonly message: string;
};

export type CaseReport = {
  readonly caseId: string;
  readonly actorName: string;
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly outcome: "passed" | "failed";
  readonly expected: string;
  readonly actual: string;
  readonly failures: readonly AuthorizationFailure[];
};

export type SuiteReport = {
  readonly suiteId: string;
  readonly outcome: "passed" | "failed" | "aborted";
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly cases: readonly CaseReport[];
  readonly failures: readonly AuthorizationFailure[];
};

export interface HttpClient {
  execute(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse>;
}

export type CatalogSecurityMode =
  | "public"
  | "browser"
  | "bearer"
  | "integration"
  | "browser-or-bearer";

export type CatalogOperation = {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly security: CatalogSecurityMode;
};

/** Loads the consumer's public operation inventory at the suite boundary. */
export interface OperationCatalog {
  load(signal: AbortSignal): Promise<readonly CatalogOperation[]>;
}

export type OperationClassification =
  | {
      readonly operationId: string;
      readonly mode: "public";
    }
  | {
      readonly operationId: string;
      readonly mode: "protocol";
      readonly security: CatalogSecurityMode;
    }
  | {
      readonly operationId: string;
      readonly mode: "authenticated";
      readonly security: "browser" | "bearer" | "browser-or-bearer";
    }
  | {
      readonly operationId: string;
      readonly mode: "excluded";
      readonly rationale: string;
    };

export interface FixtureSandbox<TFixture> {
  install(signal: AbortSignal): Promise<TFixture>;
  reset(fixture: TFixture, caseId: string, signal: AbortSignal): Promise<void>;
  dispose(fixture: TFixture | undefined, signal: AbortSignal): Promise<void>;
}

export interface SuiteReporter {
  report(report: SuiteReport): Promise<void> | void;
}

export type AuthorizationSuiteOptions<TFixture> = {
  readonly id: string;
  readonly invariants: readonly AuthorizationInvariant<TFixture>[];
  readonly reporters?: readonly SuiteReporter[];
  readonly operationClassifications?: readonly OperationClassification[];
};

/** Immutable authorization policy declarations and reporting destinations. */
export class AuthorizationSuite<TFixture> {
  readonly id: string;
  readonly invariants: readonly AuthorizationInvariant<TFixture>[];
  readonly reporters: readonly SuiteReporter[];
  readonly operationClassifications: readonly OperationClassification[];

  constructor(options: AuthorizationSuiteOptions<TFixture>) {
    this.id = options.id;
    this.invariants = Object.freeze([...options.invariants]);
    this.reporters = Object.freeze([...(options.reporters ?? [])]);
    this.operationClassifications = Object.freeze([
      ...(options.operationClassifications ?? []),
    ]);
  }
}

export class ScenarioExecutionError extends Error {
  constructor(
    readonly category: "transport-failure" | "framework-defect",
    message: string,
    readonly request: HttpRequest | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = ScenarioExecutionError.name;
  }
}

export type ScenarioExecution = {
  readonly request: HttpRequest;
  readonly response: HttpResponse;
};

export type HttpScenarioExecutorDependencies = {
  readonly httpClient: HttpClient;
  readonly redactor?: SensitiveValueRedactor;
};

/** Applies credentials and executes a case without retaining request headers. */
export class HttpScenarioExecutor {
  private readonly httpClient: HttpClient;
  private readonly redactor: SensitiveValueRedactor;

  constructor(dependencies: HttpScenarioExecutorDependencies) {
    this.httpClient = dependencies.httpClient;
    this.redactor = dependencies.redactor ?? new SensitiveValueRedactor();
  }

  async execute<TFixture>(
    actor: Actor<TFixture>,
    operation: Operation<TFixture>,
    fixture: TFixture,
    signal: AbortSignal,
  ): Promise<ScenarioExecution> {
    let request: HttpRequest;
    try {
      request = operation.buildRequest(fixture);
      if (actor.credentialProvider !== undefined) {
        request = await actor.credentialProvider.authorize({
          fixture,
          request,
          signal,
        });
      }
      if (request.method !== operation.method) {
        throw new Error(
          `operation method ${operation.method} does not match request method ${request.method}`,
        );
      }
    } catch (error) {
      throw new ScenarioExecutionError(
        "framework-defect",
        this.redactor.redactText(errorMessage(error)),
        undefined,
      );
    }

    try {
      return {
        request: {
          method: request.method,
          path: this.redactor.redactPath(request.path),
        },
        response: await this.httpClient.execute(request, signal),
      };
    } catch (error) {
      throw new ScenarioExecutionError(
        "transport-failure",
        this.redactor.redactText(errorMessage(error)),
        {
          method: request.method,
          path: this.redactor.redactPath(request.path),
        },
      );
    }
  }
}

export type AuthorizationRunnerDependencies<TFixture> = {
  readonly fixtures: FixtureSandbox<TFixture>;
  readonly httpClient: HttpClient;
  readonly caseExpander?: AuthorizationCaseExpander;
  readonly coveragePolicy?: OpenApiCoveragePolicy;
  readonly operationCatalog?: OperationCatalog;
  readonly redactor?: SensitiveValueRedactor;
};

/** Executes cases serially, aggregates policy failures, and owns fixture disposal. */
export class AuthorizationRunner<TFixture> {
  private readonly fixtures: FixtureSandbox<TFixture>;
  private readonly caseExpander: AuthorizationCaseExpander;
  private readonly coveragePolicy: OpenApiCoveragePolicy;
  private readonly operationCatalog: OperationCatalog | undefined;
  private readonly redactor: SensitiveValueRedactor;
  private readonly executor: HttpScenarioExecutor;

  constructor(dependencies: AuthorizationRunnerDependencies<TFixture>) {
    this.fixtures = dependencies.fixtures;
    this.caseExpander =
      dependencies.caseExpander ?? new AuthorizationCaseExpander();
    this.coveragePolicy =
      dependencies.coveragePolicy ?? new OpenApiCoveragePolicy();
    this.operationCatalog = dependencies.operationCatalog;
    this.redactor = dependencies.redactor ?? new SensitiveValueRedactor();
    this.executor = new HttpScenarioExecutor({
      httpClient: dependencies.httpClient,
      redactor: this.redactor,
    });
  }

  async run(
    suite: AuthorizationSuite<TFixture>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SuiteReport> {
    let installation:
      | { readonly installed: false }
      | { readonly installed: true; readonly fixture: TFixture } = {
      installed: false,
    };
    let cases: readonly AuthorizationCase<TFixture>[] = [];
    const caseReports: CaseReport[] = [];
    const suiteFailures: AuthorizationFailure[] = [];
    let aborted = false;

    try {
      try {
        cases = this.caseExpander.expand(suite.invariants);
      } catch (error) {
        aborted = true;
        suiteFailures.push(this.failure("framework-defect", error));
      }

      if (!aborted && this.operationCatalog !== undefined) {
        try {
          this.coveragePolicy.validate(
            await this.operationCatalog.load(signal),
            suite.operationClassifications,
            cases,
          );
        } catch (error) {
          aborted = true;
          suiteFailures.push(this.failure("framework-defect", error));
        }
      }

      if (!aborted) {
        try {
          installation = {
            installed: true,
            fixture: await this.fixtures.install(signal),
          };
        } catch (error) {
          aborted = true;
          suiteFailures.push(this.failure("fixture-failure", error));
        }
      }

      if (!aborted && installation.installed) {
        for (const authorizationCase of cases) {
          try {
            await this.fixtures.reset(
              installation.fixture,
              authorizationCase.id,
              signal,
            );
          } catch (error) {
            aborted = true;
            suiteFailures.push(this.failure("fixture-failure", error));
            break;
          }

          const result = await this.executeCase(
            authorizationCase,
            installation.fixture,
            signal,
          );
          caseReports.push(result.report);
          if (result.fatal) {
            aborted = true;
            break;
          }
        }
      }
    } finally {
      try {
        await this.fixtures.dispose(
          installation.installed ? installation.fixture : undefined,
          new AbortController().signal,
        );
      } catch (error) {
        aborted = true;
        suiteFailures.push(this.failure("fixture-failure", error));
      }
    }

    const report = this.buildReport(
      suite.id,
      cases.length,
      caseReports,
      suiteFailures,
      aborted,
    );
    const delivery = await this.report(suite.reporters, report);
    if (delivery.failures.length === 0) {
      return report;
    }

    let correctedReport = this.buildReport(
      suite.id,
      cases.length,
      caseReports,
      [...suiteFailures, ...delivery.failures],
      true,
    );
    const correctionFailures: AuthorizationFailure[] = [];
    for (const reporter of delivery.successfulReporters) {
      try {
        await reporter.report(correctedReport);
      } catch (error) {
        correctionFailures.push(this.failure("framework-defect", error));
      }
    }
    if (correctionFailures.length > 0) {
      correctedReport = this.buildReport(
        suite.id,
        cases.length,
        caseReports,
        [...suiteFailures, ...delivery.failures, ...correctionFailures],
        true,
      );
    }
    return correctedReport;
  }

  private async executeCase(
    authorizationCase: AuthorizationCase<TFixture>,
    fixture: TFixture,
    signal: AbortSignal,
  ): Promise<{ readonly report: CaseReport; readonly fatal: boolean }> {
    let request: HttpRequest;
    let response: HttpResponse;
    try {
      const execution = await this.executor.execute(
        authorizationCase.actor,
        authorizationCase.operation,
        fixture,
        signal,
      );
      request = execution.request;
      response = execution.response;
    } catch (error) {
      const category =
        error instanceof ScenarioExecutionError
          ? error.category
          : "framework-defect";
      const failedRequest =
        error instanceof ScenarioExecutionError ? error.request : undefined;
      return {
        report: this.caseReport(
          authorizationCase,
          failedRequest?.method ?? authorizationCase.operation.method,
          failedRequest?.path ?? "[request unavailable]",
          category === "transport-failure"
            ? "transport failure"
            : "framework defect",
          [this.failure(category, error)],
        ),
        fatal: category === "framework-defect",
      };
    }

    let mismatches: readonly ResponseMismatch[];
    try {
      mismatches = authorizationCase.expectedResponse.evaluate(
        response,
        fixture,
      );
      for (const postcondition of authorizationCase.postconditions) {
        const postconditionMismatches = await postcondition.verify({
          fixture,
          signal,
          execute: async (actor, operation, postconditionSignal) =>
            (
              await this.executor.execute(
                actor,
                operation,
                fixture,
                postconditionSignal,
              )
            ).response,
        });
        mismatches = [...mismatches, ...postconditionMismatches];
      }
    } catch (error) {
      const category =
        error instanceof ScenarioExecutionError
          ? error.category
          : "framework-defect";
      return {
        report: this.caseReport(
          authorizationCase,
          request.method,
          request.path,
          `HTTP ${response.status}`,
          [this.failure(category, error)],
        ),
        fatal: category === "framework-defect",
      };
    }

    const failures: AuthorizationFailure[] = mismatches.map((mismatch) => ({
      category:
        mismatch.kind === "policy" ? "policy-mismatch" : "malformed-response",
      message: this.redactor.redactText(mismatch.message),
    }));
    return {
      report: this.caseReport(
        authorizationCase,
        request.method,
        request.path,
        `HTTP ${response.status}`,
        failures,
      ),
      fatal: false,
    };
  }

  private caseReport(
    authorizationCase: AuthorizationCase<TFixture>,
    method: HttpMethod,
    path: string,
    actual: string,
    failures: readonly AuthorizationFailure[],
  ): CaseReport {
    return {
      caseId: authorizationCase.id,
      actorName: authorizationCase.actor.name,
      operationId: authorizationCase.operation.id,
      method,
      path: this.redactor.redactPath(path),
      outcome: failures.length === 0 ? "passed" : "failed",
      expected: this.redactor.redactText(
        authorizationCase.expectedResponse.description,
      ),
      actual: this.redactor.redactText(actual),
      failures,
    };
  }

  private failure(
    category: FailureCategory,
    error: unknown,
  ): AuthorizationFailure {
    return {
      category,
      message: this.redactor.redactText(errorMessage(error)),
    };
  }

  private buildReport(
    suiteId: string,
    total: number,
    cases: readonly CaseReport[],
    failures: readonly AuthorizationFailure[],
    aborted: boolean,
  ): SuiteReport {
    const failed = cases.filter(({ outcome }) => outcome === "failed").length;
    const passed = cases.length - failed;
    return {
      suiteId,
      outcome: aborted
        ? "aborted"
        : failed > 0 || failures.length > 0
          ? "failed"
          : "passed",
      summary: {
        total,
        passed,
        failed,
        skipped: total - cases.length,
      },
      cases: Object.freeze([...cases]),
      failures: Object.freeze([...failures]),
    };
  }

  private async report(
    reporters: readonly SuiteReporter[],
    report: SuiteReport,
  ): Promise<{
    readonly failures: readonly AuthorizationFailure[];
    readonly successfulReporters: readonly SuiteReporter[];
  }> {
    const failures: AuthorizationFailure[] = [];
    const successfulReporters: SuiteReporter[] = [];
    for (const reporter of reporters) {
      try {
        await reporter.report(report);
        successfulReporters.push(reporter);
      } catch (error) {
        failures.push(this.failure("framework-defect", error));
      }
    }
    return { failures, successfulReporters };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
