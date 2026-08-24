import { describe, expect, it } from "bun:test";
import {
  Actor,
  AuthorizationCase,
  AuthorizationRunner,
  AuthorizationSuite,
  type CredentialProvider,
  ExpectedResponse,
  type FixtureSandbox,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  HttpScenarioExecutor,
  Operation,
  type OperationCatalog,
  ScenarioExecutionError,
  type SuiteReport,
  type SuiteReporter,
} from "../src/index.ts";

type Fixture = { readonly value: string };

const unchangedCredentials: CredentialProvider<Fixture> = {
  authorize: ({ request }) => request,
};

class RecordingFixtureSandbox implements FixtureSandbox<Fixture> {
  readonly events: string[] = [];

  async install(): Promise<Fixture> {
    this.events.push("install");
    return { value: "fixture" };
  }

  async reset(_fixture: Fixture, caseId: string): Promise<void> {
    this.events.push(`reset:${caseId}`);
  }

  async dispose(
    _fixture: Fixture | undefined,
    _signal: AbortSignal,
  ): Promise<void> {
    this.events.push("dispose");
  }
}

class RecordingHttpClient implements HttpClient {
  readonly paths: string[] = [];

  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.paths.push(request.path);
    if (request.path === "/transport") {
      throw new Error(
        JSON.stringify({ access_token: "transport-access-canary" }),
      );
    }
    return { status: 403, headers: {}, body: { error: "forbidden" } };
  }
}

class RecordingReporter implements SuiteReporter {
  reports: SuiteReport[] = [];

  report(report: SuiteReport): void {
    this.reports.push(report);
  }
}

function authorizationCase(
  id: string,
  path: string,
): AuthorizationCase<Fixture> {
  return new AuthorizationCase({
    id,
    actor: new Actor({
      name: "user-a",
      authentication: "browser",
      credentialProvider: unchangedCredentials,
    }),
    operation: new Operation({
      id: `operation-${id}`,
      method: "GET",
      buildRequest: () => ({ path }),
    }),
    expectedResponse: ExpectedResponse.status(200),
  });
}

describe(AuthorizationRunner.name, () => {
  it("aborts on OpenAPI coverage failure before fixture installation", async () => {
    const fixtures = new RecordingFixtureSandbox();
    const operationCatalog: OperationCatalog = {
      load: async () => [
        { id: "operation-a", method: "GET", path: "/a", security: "browser" },
      ],
    };
    const suite = new AuthorizationSuite({
      id: "coverage-suite",
      invariants: [{ id: "none", expand: () => [] }],
      operationClassifications: [],
    });

    const report = await new AuthorizationRunner({
      fixtures,
      httpClient: new RecordingHttpClient(),
      operationCatalog,
    }).run(suite);

    expect(fixtures.events).toEqual(["dispose"]);
    expect(report.outcome).toBe("aborted");
    expect(report.failures).toEqual([
      {
        category: "framework-defect",
        message: "missing classification: operation-a",
      },
    ]);
  });

  it("rejects credential providers that substitute the declared method", async () => {
    let requests = 0;
    const executor = new HttpScenarioExecutor({
      httpClient: {
        execute: async () => {
          requests += 1;
          return { status: 200, headers: {}, body: null };
        },
      },
    });
    const actor = new Actor<Fixture>({
      name: "user-a",
      authentication: "browser",
      credentialProvider: {
        authorize: ({ request }) => ({ ...request, method: "DELETE" }),
      },
    });
    const operation = new Operation<Fixture>({
      id: "get-device",
      method: "GET",
      buildRequest: () => ({ path: "/v1/devices" }),
    });

    expect(
      executor.execute(
        actor,
        operation,
        { value: "fixture" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "operation method GET does not match request method DELETE",
    );
    expect(requests).toBe(0);
  });

  it("redacts serialized credential-provider failures", async () => {
    const executor = new HttpScenarioExecutor({
      httpClient: new RecordingHttpClient(),
    });
    const actor = new Actor<Fixture>({
      name: "user-a",
      authentication: "browser",
      credentialProvider: {
        authorize: () => {
          throw new Error(
            JSON.stringify({ cookie: "credential-cookie-canary" }),
          );
        },
      },
    });
    const operation = new Operation<Fixture>({
      id: "get-device",
      method: "GET",
      buildRequest: () => ({ path: "/v1/devices" }),
    });

    const error = await executor
      .execute(
        actor,
        operation,
        { value: "fixture" },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain('"cookie":"[REDACTED]"');
    expect(String(error)).not.toContain("credential-cookie-canary");
  });

  it("redacts executor failures and retained request metadata", async () => {
    const executor = new HttpScenarioExecutor({
      httpClient: {
        execute: async () => {
          throw new Error("Authorization: Basic executor-secret");
        },
      },
    });
    const actor = new Actor<Fixture>({
      name: "user-a",
      authentication: "browser",
      credentialProvider: unchangedCredentials,
    });
    const operation = new Operation<Fixture>({
      id: "sensitive-operation",
      method: "GET",
      buildRequest: () => ({
        path: "/v1/devices?access_token=path-secret",
      }),
    });

    let caught: unknown;
    try {
      await executor.execute(
        actor,
        operation,
        { value: "fixture" },
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ScenarioExecutionError);
    if (!(caught instanceof ScenarioExecutionError)) {
      throw new Error("expected ScenarioExecutionError");
    }
    expect(caught.message).toBe("Authorization: [REDACTED]");
    expect(caught.request).toEqual({
      method: "GET",
      path: "/v1/devices?access_token=[REDACTED]",
    });
    expect(caught.cause).toBeUndefined();
  });

  it("executes sorted cases serially, aggregates safe failures, reports, and disposes", async () => {
    const fixtures = new RecordingFixtureSandbox();
    const httpClient = new RecordingHttpClient();
    const reporter = new RecordingReporter();
    const suite = new AuthorizationSuite({
      id: "example-suite",
      invariants: [
        {
          id: "example",
          expand: () => [
            authorizationCase("z-transport", "/transport"),
            authorizationCase("a-policy", "/policy"),
          ],
        },
      ],
      reporters: [reporter],
    });

    const report = await new AuthorizationRunner({
      fixtures,
      httpClient,
    }).run(suite);

    expect(httpClient.paths).toEqual(["/policy", "/transport"]);
    expect(fixtures.events).toEqual([
      "install",
      "reset:a-policy",
      "reset:z-transport",
      "dispose",
    ]);
    expect(report).toEqual({
      suiteId: "example-suite",
      outcome: "failed",
      summary: { total: 2, passed: 0, failed: 2, skipped: 0 },
      cases: [
        {
          caseId: "a-policy",
          actorName: "user-a",
          operationId: "operation-a-policy",
          method: "GET",
          path: "/policy",
          outcome: "failed",
          expected: "HTTP 200",
          actual: "HTTP 403",
          failures: [
            {
              category: "policy-mismatch",
              message: "expected HTTP 200, received HTTP 403",
            },
          ],
        },
        {
          caseId: "z-transport",
          actorName: "user-a",
          operationId: "operation-z-transport",
          method: "GET",
          path: "/transport",
          outcome: "failed",
          expected: "HTTP 200",
          actual: "transport failure",
          failures: [
            {
              category: "transport-failure",
              message: '{"access_token":"[REDACTED]"}',
            },
          ],
        },
      ],
      failures: [],
    });
    expect(reporter.reports).toEqual([report]);
  });

  it("aborts after fixture integrity fails and still disposes", async () => {
    const fixtures = new RecordingFixtureSandbox();
    fixtures.reset = async (_fixture, caseId) => {
      fixtures.events.push(`reset:${caseId}`);
      throw new Error(
        JSON.stringify({
          database_url: "postgresql://suite:fixture-canary@db/test",
        }),
      );
    };
    const httpClient = new RecordingHttpClient();
    const suite = new AuthorizationSuite({
      id: "example-suite",
      invariants: [
        { id: "example", expand: () => [authorizationCase("a", "/a")] },
      ],
    });

    const report = await new AuthorizationRunner({
      fixtures,
      httpClient,
    }).run(suite);

    expect(report.outcome).toBe("aborted");
    expect(report.failures).toEqual([
      {
        category: "fixture-failure",
        message: '{"database_url":"[REDACTED]"}',
      },
    ]);
    expect(httpClient.paths).toEqual([]);
    expect(fixtures.events).toEqual(["install", "reset:a", "dispose"]);
  });

  it("disposes with an independent signal when execution is cancelled", async () => {
    const controller = new AbortController();
    const fixtures = new RecordingFixtureSandbox();
    let disposalWasCancelled = false;
    fixtures.dispose = async (_fixture, signal) => {
      disposalWasCancelled = signal.aborted;
      fixtures.events.push("dispose");
      if (signal.aborted) {
        throw new Error("cleanup cancelled");
      }
    };
    const httpClient: HttpClient = {
      execute: async () => {
        controller.abort();
        return { status: 200, headers: {}, body: null };
      },
    };
    const suite = new AuthorizationSuite({
      id: "cancelled-suite",
      invariants: [
        { id: "example", expand: () => [authorizationCase("a", "/a")] },
      ],
    });

    const report = await new AuthorizationRunner({ fixtures, httpClient }).run(
      suite,
      controller.signal,
    );

    expect(disposalWasCancelled).toBe(false);
    expect(report.outcome).toBe("passed");
    expect(fixtures.events).toEqual(["install", "reset:a", "dispose"]);
  });

  it("classifies reporter failures as framework defects", async () => {
    const fixtures = new RecordingFixtureSandbox();
    const successfulReporter = new RecordingReporter();
    const suite = new AuthorizationSuite({
      id: "reporter-failure-suite",
      invariants: [],
      reporters: [
        successfulReporter,
        {
          report: () => {
            throw new Error(
              JSON.stringify({ refresh_token: "report-refresh-canary" }),
            );
          },
        },
      ],
    });

    const report = await new AuthorizationRunner({
      fixtures,
      httpClient: new RecordingHttpClient(),
    }).run(suite);

    expect(report.outcome).toBe("aborted");
    expect(report.failures).toEqual([
      {
        category: "framework-defect",
        message: '{"refresh_token":"[REDACTED]"}',
      },
    ]);
    expect(successfulReporter.reports).toHaveLength(2);
    expect(successfulReporter.reports.map(({ outcome }) => outcome)).toEqual([
      "passed",
      "aborted",
    ]);
    expect(fixtures.events).toEqual(["install", "dispose"]);
  });
});
