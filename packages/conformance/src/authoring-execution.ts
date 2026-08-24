import type { AuthorizationCase } from "./model.ts";
import {
  AuthorizationRunner,
  AuthorizationSuite,
  type FixtureSandbox,
  type HttpClient,
  type SuiteReport,
} from "./runner.ts";

export interface FixtureLifecycle<Fixture> {
  create(): Promise<Fixture>;
  dispose(fixture: Fixture): Promise<void>;
}

export type AuthoringExecutionOptions<Fixture> = {
  readonly suiteId: string;
  readonly cases: readonly AuthorizationCase<Fixture>[];
  readonly lifecycle: FixtureLifecycle<Fixture>;
  readonly httpClient: HttpClient;
};

class PerCaseFixtureSandbox<Fixture> implements FixtureSandbox<Fixture> {
  private fixture:
    | { readonly created: false }
    | { readonly created: true; readonly value: Fixture } = { created: false };

  constructor(private readonly lifecycle: FixtureLifecycle<Fixture>) {}

  async install(_signal: AbortSignal): Promise<Fixture> {
    const value = await this.lifecycle.create();
    this.fixture = { created: true, value };
    return value;
  }

  async reset(
    _fixture: Fixture,
    _caseId: string,
    _signal: AbortSignal,
  ): Promise<void> {}

  async dispose(
    _fixture: Fixture | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    if (!this.fixture.created) {
      return;
    }

    await this.lifecycle.dispose(this.fixture.value);
    this.fixture = { created: false };
  }
}

export async function runAuthorizationCases<Fixture>(
  options: AuthoringExecutionOptions<Fixture>,
): Promise<SuiteReport> {
  const reports: SuiteReport[] = [];

  for (const authorizationCase of options.cases) {
    const runner = new AuthorizationRunner({
      fixtures: new PerCaseFixtureSandbox(options.lifecycle),
      httpClient: options.httpClient,
    });
    reports.push(
      await runner.run(
        new AuthorizationSuite({
          id: `${options.suiteId}/${authorizationCase.id}`,
          invariants: [
            {
              id: authorizationCase.id,
              expand: () => [authorizationCase],
            },
          ],
        }),
      ),
    );
  }

  const cases = Object.freeze(reports.flatMap((report) => report.cases));
  const failures = Object.freeze(reports.flatMap((report) => report.failures));
  const passed = cases.filter(({ outcome }) => outcome === "passed").length;
  const failed = cases.length - passed;
  const aborted = reports.some(({ outcome }) => outcome === "aborted");

  return {
    suiteId: options.suiteId,
    outcome: aborted
      ? "aborted"
      : failed > 0 || failures.length > 0
        ? "failed"
        : "passed",
    summary: {
      total: options.cases.length,
      passed,
      failed,
      skipped: options.cases.length - cases.length,
    },
    cases,
    failures,
  };
}
