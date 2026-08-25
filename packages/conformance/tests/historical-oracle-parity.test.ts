import { describe, expect, it } from "bun:test";
import { runAuthorizationCases } from "../src/authoring-runtime.ts";
import type { HttpRequest, HttpResponse } from "../src/model.ts";
import type { HttpClient } from "../src/runner.ts";
import oracle from "./fixtures/historical-authorization-oracle.json" with {
  type: "json",
};
import {
  buildHistoricalOracleContract,
  createHistoricalOracleLifecycle,
  historicalOracleActors,
} from "./support/historical-oracle-contract.ts";

class OracleHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private nextCase = 0;

  constructor(private readonly events: string[]) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const oracleCase = oracle.cases[this.nextCase];
    if (oracleCase === undefined) {
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    }
    this.nextCase += 1;
    this.events.push(`request:${this.nextCase}`);
    this.requests.push(request);
    expect(Bun.deepEquals(request, expectedRequest(oracleCase.request))).toBe(
      true,
    );
    return {
      status: oracleCase.expected.status,
      headers: {},
      body:
        oracleCase.expected.body === null
          ? undefined
          : oracleCase.expected.body,
    };
  }
}

function expectedRequest(request: {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}): object {
  return {
    method: request.method,
    path: request.path,
    ...(Object.keys(request.headers).length === 0
      ? {}
      : { headers: request.headers }),
    ...(request.body === null ? {} : { body: request.body }),
  };
}

describe("historical authorization behavioral oracle parity", () => {
  it("reproduces a balanced 30-case oracle in stable ID order", () => {
    const contract = buildHistoricalOracleContract();

    expect(oracle.provenance.commit).toBe(
      "a87cf00af3ab2792ae5eb7382aaae3326ad524b0",
    );
    expect(oracle.cases).toHaveLength(30);
    expect(
      oracle.cases.reduce<Record<string, number>>((counts, oracleCase) => {
        counts[oracleCase.category] = (counts[oracleCase.category] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ tracer: 10, admin: 10, protocol: 10 });
    const actorSessions = new Map(
      Object.entries(historicalOracleActors).map(([actor, { session }]) => [
        actor,
        session,
      ]),
    );
    for (const { actor, session } of oracle.cases) {
      expect(actorSessions.get(actor) === session).toBe(true);
    }
    expect(contract.map(({ id }) => id)).toEqual(
      oracle.cases.map(({ id }) => id),
    );
    expect(contract.map(({ actor }) => actor.name)).toEqual(
      oracle.cases.map(({ actor }) => actor),
    );
    expect(contract.map(({ id }) => id)).toEqual(
      [...contract.map(({ id }) => id)].sort(),
    );
  });

  it("preserves representative tracer, admin, and protocol declarations", () => {
    const contract = buildHistoricalOracleContract();
    const representatives = [
      "account.me.anonymous",
      "admin.invitations.create.ordering.anonymous",
      "protocol.poll.pending-safe-error",
    ];

    expect(
      representatives.map((id) => {
        const authorizationCase = contract.find(
          (candidate) => candidate.id === id,
        );
        return {
          id: authorizationCase?.id,
          actor: authorizationCase?.actor.name,
          request: authorizationCase?.operation.buildRequest({ instance: 1 }),
          expected: authorizationCase?.expectedResponse.description,
        };
      }),
    ).toEqual([
      {
        id: "account.me.anonymous",
        actor: "anonymous",
        request: { method: "GET", path: "/v1/me" },
        expected: "custom response assertion",
      },
      {
        id: "admin.invitations.create.ordering.anonymous",
        actor: "anonymous",
        request: {
          method: "POST",
          path: "/v1/admin/invitations",
          headers: { "Content-Type": "application/json" },
          body: { email: "malformed-email" },
        },
        expected: "custom response assertion",
      },
      {
        id: "protocol.poll.pending-safe-error",
        actor: "anonymous",
        request: {
          method: "POST",
          path: "/api/auth/device/token",
          headers: { "Content-Type": "application/json" },
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: "<PENDING_DEVICE_CODE>",
            client_id: "ping-the-human-cli",
          },
        },
        expected: "HTTP 400 error authorization_pending",
      },
    ]);
  });

  it("distinguishes and constrains every recorded outcome mode", async () => {
    const contract = buildHistoricalOracleContract();
    const assertions = new Set(
      oracle.cases.map(({ expected }) => expected.assertion),
    );

    expect(assertions).toEqual(
      new Set(["strict-body", "oauth-error", "status-only", "no-content"]),
    );

    for (const [index, oracleCase] of oracle.cases.entries()) {
      const authorizationCase = contract[index];
      if (authorizationCase === undefined) {
        throw new Error(`missing declaration for ${oracleCase.id}`);
      }
      const expectedBody =
        oracleCase.expected.body === null
          ? undefined
          : oracleCase.expected.body;
      const fixture = { instance: index + 1 };
      expect(
        await authorizationCase.expectedResponse.evaluate(
          {
            status: oracleCase.expected.status,
            headers: {},
            body: expectedBody,
          },
          fixture,
        ),
      ).toEqual([]);
      expect(
        await authorizationCase.expectedResponse.evaluate(
          {
            status: oracleCase.expected.status + 1,
            headers: {},
            body: expectedBody,
          },
          fixture,
        ),
      ).not.toEqual([]);

      if (
        oracleCase.expected.assertion === "strict-body" &&
        oracleCase.expected.body !== null
      ) {
        expect(
          await authorizationCase.expectedResponse.evaluate(
            {
              status: oracleCase.expected.status,
              headers: {},
              body: { ...oracleCase.expected.body, unexpected: true },
            },
            fixture,
          ),
        ).not.toEqual([]);
      }
      if (oracleCase.expected.assertion === "oauth-error") {
        expect(
          await authorizationCase.expectedResponse.evaluate(
            {
              status: oracleCase.expected.status,
              headers: {},
              body: { error: "different_error" },
            },
            fixture,
          ),
        ).not.toEqual([]);
      }
      if (oracleCase.expected.assertion === "no-content") {
        expect(
          await authorizationCase.expectedResponse.evaluate(
            {
              status: oracleCase.expected.status,
              headers: {},
              body: "unexpected",
            },
            fixture,
          ),
        ).not.toEqual([]);
      }
    }
  });

  it("keeps credentials exclusively in actor sessions", () => {
    const contract = buildHistoricalOracleContract();

    for (const [index, authorizationCase] of contract.entries()) {
      const request = authorizationCase.operation.buildRequest({
        instance: index + 1,
      });
      const authenticationHeaders = Object.keys(request.headers ?? {}).filter(
        (header) => {
          const normalizedHeader = header.toLowerCase();
          return (
            normalizedHeader === "authorization" ||
            normalizedHeader === "cookie"
          );
        },
      );
      expect(authenticationHeaders).toEqual([]);
    }
  });

  it("executes exact requests and outcomes with one fresh fixture and session per case", async () => {
    const events: string[] = [];
    const lifecycle = createHistoricalOracleLifecycle(events);
    const contract = buildHistoricalOracleContract(lifecycle);
    const client = new OracleHttpClient(events);

    const report = await runAuthorizationCases({
      suiteId: "historical-authorization-oracle",
      cases: contract,
      lifecycle,
      httpClient: client,
    });

    expect(report.outcome).toBe("passed");
    expect(report.summary).toEqual({
      total: 30,
      passed: 30,
      failed: 0,
      skipped: 0,
    });
    expect(client.requests).toHaveLength(oracle.cases.length);
    expect(events).toEqual(
      oracle.cases.flatMap(({ actor, session }, index) => {
        const instance = index + 1;
        return [
          `create:${instance}`,
          `session:${instance}:${actor}:${session}`,
          `request:${instance}`,
          `dispose:${instance}`,
        ];
      }),
    );
    expect(
      report.cases.map(({ caseId, actorName, outcome }) => ({
        caseId,
        actorName,
        outcome,
      })),
    ).toEqual(
      oracle.cases.map(({ id, actor }) => ({
        caseId: id,
        actorName: actor,
        outcome: "passed",
      })),
    );
  });

  it("redacts selected bearer and cookie credentials from transport failures", async () => {
    const events: string[] = [];
    const lifecycle = createHistoricalOracleLifecycle(events);
    const contract = buildHistoricalOracleContract(lifecycle);
    const bearerCase = contract.find(
      ({ id }) => id === "account.me.cli-bearer-a",
    );
    const browserCase = contract.find(
      ({ id }) => id === "account.me.revoked-user",
    );
    if (bearerCase === undefined || browserCase === undefined) {
      throw new Error("missing credential redaction oracle cases");
    }
    const client: HttpClient = {
      async execute(request) {
        throw new Error(
          `credential failure ${JSON.stringify(request.headers ?? {})}`,
        );
      },
    };

    const report = await runAuthorizationCases({
      suiteId: "historical-redaction-probe",
      cases: [bearerCase, browserCase],
      lifecycle,
      httpClient: client,
    });
    const serialized = JSON.stringify(report);

    expect(report.outcome).toBe("failed");
    expect(report.summary.failed).toBe(2);
    expect(serialized).not.toContain("<CLI_BEARER_A>");
    expect(serialized).not.toContain("<SIGNED_SESSION_TOKEN_REVOKEDUSER>");
    expect(serialized).toContain("[REDACTED]");
  });
});
