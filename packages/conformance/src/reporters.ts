import { compareStableText } from "./ordering.ts";
import { SensitiveValueRedactor } from "./redaction.ts";
import type {
  AuthorizationFailure,
  CaseReport,
  SuiteReport,
  SuiteReporter,
} from "./runner.ts";

export interface TextOutput {
  write(value: string): Promise<void> | void;
}

export type ReporterDependencies = {
  readonly output: TextOutput;
  readonly redactor?: SensitiveValueRedactor;
};

/** Emits one compact summary plus actionable failed-case lines. */
export class ConsoleReporter implements SuiteReporter {
  private readonly output: TextOutput;
  private readonly redactor: SensitiveValueRedactor;

  constructor(dependencies: ReporterDependencies) {
    this.output = dependencies.output;
    this.redactor = dependencies.redactor ?? new SensitiveValueRedactor();
  }

  report(report: SuiteReport): Promise<void> | void {
    const status = report.outcome === "passed" ? "PASS" : "FAIL";
    const lines = [
      `${status} ${this.redactor.redactText(report.suiteId)} (${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped)`,
    ];

    for (const authorizationCase of [...report.cases].sort(compareCases)) {
      if (authorizationCase.outcome === "passed") {
        continue;
      }
      const failures = authorizationCase.failures
        .map(
          ({ category, message }) =>
            `${category}: ${this.redactor.redactText(message)}`,
        )
        .join("; ");
      lines.push(
        `  FAIL ${this.redactor.redactText(authorizationCase.caseId)} [${this.redactor.redactText(authorizationCase.actorName)}] ${this.redactor.redactText(authorizationCase.method)} ${this.redactor.redactPath(authorizationCase.path)} ${this.redactor.redactText(authorizationCase.operationId)} — expected ${this.redactor.redactText(authorizationCase.expected)}; actual ${this.redactor.redactText(authorizationCase.actual)}; ${failures}`,
      );
    }

    for (const failure of sortedFailures(report.failures)) {
      lines.push(
        `  ${failure.category}: ${this.redactor.redactText(failure.message)}`,
      );
    }

    return this.output.write(`${lines.join("\n")}\n`);
  }
}

/** Emits a canonical JSON artifact with deterministic keys and array order. */
export class JsonReporter implements SuiteReporter {
  private readonly output: TextOutput;
  private readonly redactor: SensitiveValueRedactor;

  constructor(dependencies: ReporterDependencies) {
    this.output = dependencies.output;
    this.redactor = dependencies.redactor ?? new SensitiveValueRedactor();
  }

  report(report: SuiteReport): Promise<void> | void {
    return this.output.write(
      `${JSON.stringify(this.canonicalize(report), null, 2)}\n`,
    );
  }

  private canonicalize(report: SuiteReport): SuiteReport {
    return {
      suiteId: this.redactor.redactText(report.suiteId),
      outcome: report.outcome,
      summary: {
        total: report.summary.total,
        passed: report.summary.passed,
        failed: report.summary.failed,
        skipped: report.summary.skipped,
      },
      cases: [...report.cases].sort(compareCases).map((authorizationCase) => ({
        caseId: this.redactor.redactText(authorizationCase.caseId),
        actorName: this.redactor.redactText(authorizationCase.actorName),
        operationId: this.redactor.redactText(authorizationCase.operationId),
        method: authorizationCase.method,
        path: this.redactor.redactPath(authorizationCase.path),
        outcome: authorizationCase.outcome,
        expected: this.redactor.redactText(authorizationCase.expected),
        actual: this.redactor.redactText(authorizationCase.actual),
        failures: sortedFailures(authorizationCase.failures).map((failure) =>
          this.redactFailure(failure),
        ),
      })),
      failures: sortedFailures(report.failures).map((failure) =>
        this.redactFailure(failure),
      ),
    };
  }

  private redactFailure(failure: AuthorizationFailure): AuthorizationFailure {
    return {
      category: failure.category,
      message: this.redactor.redactText(failure.message),
    };
  }
}

function compareCases(left: CaseReport, right: CaseReport): number {
  return compareStableText(left.caseId, right.caseId);
}

function sortedFailures(
  failures: readonly AuthorizationFailure[],
): readonly AuthorizationFailure[] {
  return [...failures].sort(
    (left, right) =>
      compareStableText(left.category, right.category) ||
      compareStableText(left.message, right.message),
  );
}
