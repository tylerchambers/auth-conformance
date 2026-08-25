import {
  type BuiltAuthorizationContract,
  contractMetadata,
} from "./authoring-contract.ts";
import type { AuthorizationCase, HttpRequest, HttpResponse } from "./model.ts";
import {
  AuthorizationRunner,
  AuthorizationSuite,
  type FixtureLifecycle,
  type HttpClient,
  type SuiteReport,
} from "./runner.ts";

class FetchHttpClient implements HttpClient {
  constructor(private readonly baseUrl: () => string | URL) {}

  async execute(
    request: HttpRequest,
    signal: AbortSignal,
  ): Promise<HttpResponse> {
    const headers = new Headers(request.headers);
    const body = requestBody(request, headers);
    const requestInit: RequestInit = {
      method: request.method,
      headers,
      signal,
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const response = await fetch(
      new URL(request.path, this.baseUrl()),
      requestInit,
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody(text, response.headers.get("content-type")),
    };
  }
}

function requestBody(
  request: HttpRequest,
  headers: Headers,
): BodyInit | undefined {
  if (request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === "string") {
    return request.body;
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(request.body);
}

function responseBody(text: string, contentType: string | null): unknown {
  if (text === "") {
    return undefined;
  }
  if (contentType?.toLowerCase().includes("json") !== true) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type AuthoringExecutionOptions<Fixture> = {
  readonly suiteId: string;
  readonly cases: readonly AuthorizationCase<Fixture>[];
  readonly lifecycle: FixtureLifecycle<Fixture>;
  readonly httpClient: HttpClient;
};

export async function runAuthorizationCases<Fixture>(
  options: AuthoringExecutionOptions<Fixture>,
  signal?: AbortSignal,
): Promise<SuiteReport> {
  const invariants = options.cases.map((authorizationCase) => ({
    id: authorizationCase.id,
    expand: () => [authorizationCase],
  }));
  return new AuthorizationRunner({
    lifecycle: options.lifecycle,
    httpClient: options.httpClient,
  }).run(
    new AuthorizationSuite({
      id: options.suiteId,
      invariants,
    }),
    signal,
  );
}

/** Configures cancellation for a public authorization test run. */
export type AuthorizationTestRunOptions = {
  /** Aborts HTTP requests with a caller-owned signal. */
  readonly signal?: AbortSignal;
};

/**
 * Runs a built contract serially against its configured service endpoint.
 *
 * Creates and disposes a fresh fixture for each case, applies the selected
 * session immediately before its request, and returns failures in the report.
 * Fixture and framework failures abort any remaining cases; transport failures
 * and policy mismatches are reported per case and execution continues. This
 * function does not throw merely because cases fail. Pass an `AbortSignal`,
 * such as `AbortSignal.timeout(...)`, to bound HTTP execution.
 *
 * @throws When passed a value not produced by the contract builder.
 */
export async function runAuthorizationTests<Fixture>(
  contract: BuiltAuthorizationContract<Fixture>,
  options: AuthorizationTestRunOptions = {},
): Promise<SuiteReport> {
  const metadata = contract[contractMetadata];
  if (metadata === undefined) {
    throw new TypeError(
      "runAuthorizationTests expects the result of authorizationContract(...).build()",
    );
  }
  return runAuthorizationCases(
    {
      suiteId: metadata.name,
      cases: contract,
      lifecycle: metadata.lifecycle,
      httpClient: new FetchHttpClient(metadata.baseUrl),
    },
    options.signal,
  );
}
