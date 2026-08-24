import { describe, expect, it } from "bun:test";
import {
  authorizationContract,
  fromOpenApi,
  runAuthorizationTests,
  sessions,
} from "../src/authoring.ts";
import { runAuthorizationCases } from "../src/authoring-runtime.ts";
import type { HttpRequest, HttpResponse } from "../src/model.ts";
import type { HttpClient } from "../src/runner.ts";

type Fixture = {
  readonly id: number;
  readonly token: string;
  readonly deviceId: string;
};

const lifecycle = {
  async create(): Promise<Fixture> {
    return { id: 1, token: "fixture-token", deviceId: "device/1" };
  },
  async dispose(_fixture: Fixture): Promise<void> {},
};

function readErrorCode(body: unknown): unknown {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = body.error;
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return error.code;
}

function newContract() {
  return authorizationContract({
    name: "authoring-tests",
    baseUrl: () => "http://127.0.0.1",
    error: { code: readErrorCode },
    lifecycle,
  }).actor(
    "member",
    sessions.bearer(({ fixture }) => fixture.token),
  );
}

const okResponse: HttpResponse = {
  status: 200,
  headers: {},
  body: { id: 1 },
};

describe("sessions", () => {
  it("constructs anonymous, bearer, API-key, cookie, and header sessions", async () => {
    const fixture = await lifecycle.create();
    const context = { fixture };

    expect(await sessions.anonymous<Fixture>()(context)).toEqual({});
    expect(await sessions.bearer<Fixture>("literal-token")(context)).toEqual({
      headers: { Authorization: "Bearer literal-token" },
    });
    expect(
      await sessions.bearer<Fixture>(
        async ({ fixture: current }) => current.token,
      )(context),
    ).toEqual({ headers: { Authorization: "Bearer fixture-token" } });
    expect(
      await sessions.apiKey<Fixture>("X-API-Key", ({ fixture: current }) =>
        Promise.resolve(`key-${current.id}`),
      )(context),
    ).toEqual({ headers: { "X-API-Key": "key-1" } });
    expect(
      await sessions.cookies<Fixture>(({ fixture: current }) => ({
        session: `session-${current.id}`,
      }))(context),
    ).toEqual({ cookies: { session: "session-1" } });
    expect(
      await sessions.fromHeaders<Fixture>(async ({ fixture: current }) => ({
        "X-Fixture": String(current.id),
      }))(context),
    ).toEqual({ headers: { "X-Fixture": "1" } });
  });
});

describe("authorizationContract cases", () => {
  it("infers fixtures and constructs the existing authorization-case IR", () => {
    const contract = newContract();
    contract
      .case("member can read a device")
      .as("member")
      .get("/devices/:deviceId", {
        params: {
          deviceId: ({ fixture }) => fixture.deviceId,
        },
      })
      .expectStatus(200);

    const cases = contract.build();

    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe(
      "member-can-read-a-device/get-devices-deviceid/member",
    );
    expect(cases[0]?.actor.name).toBe("member");
    expect(
      cases[0]?.operation.buildRequest({
        id: 1,
        token: "token",
        deviceId: "device/1",
      }),
    ).toEqual({
      method: "GET",
      path: "/devices/device%2F1",
    });
  });

  it("declares every supported HTTP verb", () => {
    const contract = newContract();
    contract.case("delete").as("member").delete("/resource").expectStatus(200);
    contract.case("get").as("member").get("/resource").expectStatus(200);
    contract.case("head").as("member").head("/resource").expectStatus(200);
    contract.case("patch").as("member").patch("/resource").expectStatus(200);
    contract.case("post").as("member").post("/resource").expectStatus(200);
    contract.case("put").as("member").put("/resource").expectStatus(200);

    expect(
      contract
        .build()
        .map(({ operation }) => operation.buildRequest(awaitFixture()).method),
    ).toEqual(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
  });

  it("supports explicit IDs and rejects generated-ID collisions", () => {
    const explicit = newContract();
    explicit
      .case("same description")
      .id("explicit-case")
      .as("member")
      .get("/devices")
      .expectStatus(200);
    expect(explicit.build()[0]?.id).toBe("explicit-case");

    const colliding = newContract();
    colliding
      .case("same description")
      .as("member")
      .get("/devices")
      .expectStatus(200);
    colliding
      .case("same description")
      .as("member")
      .get("/devices")
      .expectStatus(204);

    expect(() => colliding.build()).toThrow(
      "Duplicate authorization case ID: same-description/get-devices/member",
    );
  });

  it("enforces path params and exactly one expectation in the type surface", () => {
    const contract = newContract();

    const compileTimeAssertions = () => {
      // @ts-expect-error A path parameter requires a params object.
      contract.case("missing").as("member").get("/devices/:deviceId");
      const parameterFree = contract.case("extra").as("member");
      // @ts-expect-error Parameter-free paths reject unused params.
      parameterFree.get("/devices", { params: { deviceId: "unused" } });
      const completed = contract
        .case("double expectation")
        .as("member")
        .get("/devices")
        .expectStatus(200);
      // @ts-expect-error A terminal expectation cannot be followed by another.
      completed.expectBody([]);
      // @ts-expect-error Actor names are limited to registered actors.
      contract.case("unknown actor").as("administrator");
    };

    expect(compileTimeAssertions).toBeInstanceOf(Function);

    expect(contract.build()).toHaveLength(0);
  });

  it("rejects unfinished declarations and reused terminal builders", () => {
    const unfinished = newContract();
    unfinished.case("unfinished");
    expect(() => unfinished.build()).toThrow(
      'Authorization case "unfinished" requires exactly one expectation',
    );

    const reused = newContract();
    const terminal = reused.case("once").as("member").get("/resource");
    terminal.expectStatus(200);
    expect(() => terminal.expectStatus(204)).toThrow(
      "accepts exactly one expectation",
    );
  });
});

describe("authoring expectations", () => {
  it("matches status and reports status mismatches", async () => {
    const contract = newContract();
    contract.case("status").as("member").get("/status").expectStatus(201);
    const expected = contract.build()[0]?.expectedResponse;

    expect(await expected?.evaluate({ ...okResponse, status: 201 })).toEqual(
      [],
    );
    expect(await expected?.evaluate(okResponse)).toEqual([
      {
        kind: "policy",
        message: "expected HTTP 201, received HTTP 200",
      },
    ]);
  });

  it("distinguishes strict body equality from deep subset matching", async () => {
    const strict = newContract();
    strict.case("strict").as("member").get("/strict").expectBody({ id: 1 });
    const containing = newContract();
    containing
      .case("containing")
      .as("member")
      .get("/containing")
      .expectBodyContaining({ items: [{ id: 1 }] });

    expect(
      await strict.build()[0]?.expectedResponse.evaluate({
        ...okResponse,
        body: { id: 1, extra: true },
      }),
    ).toHaveLength(1);
    expect(
      await containing.build()[0]?.expectedResponse.evaluate({
        ...okResponse,
        body: { items: [{ id: 1, extra: true }], page: 1 },
      }),
    ).toEqual([]);
  });

  it("matches no-content and configured error envelopes", async () => {
    const noContent = newContract();
    noContent
      .case("no content")
      .as("member")
      .delete("/devices/:deviceId", { params: { deviceId: "1" } })
      .expectNoContent();
    const error = newContract();
    error
      .case("error")
      .as("member")
      .get("/devices/:deviceId", { params: { deviceId: "missing" } })
      .expectError(404, "DEVICE_NOT_FOUND");

    expect(
      await noContent.build()[0]?.expectedResponse.evaluate({
        status: 204,
        headers: {},
        body: undefined,
      }),
    ).toEqual([]);
    expect(
      await noContent.build()[0]?.expectedResponse.evaluate({
        status: 204,
        headers: {},
        body: null,
      }),
    ).toHaveLength(1);
    expect(
      await error.build()[0]?.expectedResponse.evaluate({
        status: 404,
        headers: {},
        body: { error: { code: "DEVICE_NOT_FOUND" } },
      }),
    ).toEqual([]);
  });

  it("passes the response and inferred fixture to async callback assertions", async () => {
    const contract = newContract();
    contract
      .case("callback")
      .as("member")
      .head("/devices")
      .expectThat(async ({ response, fixture }) => {
        await Promise.resolve();
        expect(response.status).toBe(200);
        expect(fixture.token).toBe("fixture-token");
      });
    const expected = contract.build()[0]?.expectedResponse;

    expect(
      await expected?.evaluate(okResponse, {
        id: 1,
        token: "fixture-token",
        deviceId: "device-1",
      }),
    ).toEqual([]);
  });
});

describe("authorization rules", () => {
  const inventory = fromOpenApi({
    openapi: "3.1.0",
    paths: {
      "/zebra": {
        post: { operationId: "createZebra", tags: ["animals"] },
      },
      "/aardvarks": {
        get: { operationId: "listAardvarks", tags: ["animals", "lists"] },
      },
    },
  });

  it("expands selected operations into deterministic ordinary cases", () => {
    const contract = authorizationContract({
      name: "rules",
      baseUrl: () => "http://127.0.0.1",
      error: { code: () => undefined },
      lifecycle,
      operations: inventory,
    }).actor("anonymous", sessions.anonymous());

    contract
      .rule("all animals are protected")
      .forOperations({ tags: ["animals"] })
      .as("anonymous")
      .expectError(401);

    const cases = contract.build();
    expect(cases.map(({ id }) => id)).toEqual([
      "all-animals-are-protected/createZebra/anonymous",
      "all-animals-are-protected/listAardvarks/anonymous",
    ]);
    expect(
      cases.map(({ operation }) => operation.buildRequest(awaitFixture())),
    ).toEqual([
      { method: "POST", path: "/zebra" },
      { method: "GET", path: "/aardvarks" },
    ]);
  });

  it("expands all inventoried operations", () => {
    const contract = authorizationContract({
      name: "all-rules",
      baseUrl: () => "http://127.0.0.1",
      error: { code: () => undefined },
      lifecycle,
      operations: inventory,
    }).actor("anonymous", sessions.anonymous());
    contract
      .rule("all operations")
      .forAllOperations()
      .as("anonymous")
      .expectStatus(401);

    expect(contract.build().map(({ operation }) => operation.id)).toEqual([
      "createZebra",
      "listAardvarks",
    ]);
  });

  it("fails loudly for missing inventories, operation IDs, and tags", () => {
    const withoutInventory = newContract();
    expect(() => withoutInventory.rule("all").forAllOperations()).toThrow(
      "requires an operation inventory",
    );

    const contract = authorizationContract({
      name: "rules",
      baseUrl: () => "http://127.0.0.1",
      error: { code: () => undefined },
      lifecycle,
      operations: inventory,
    }).actor("anonymous", sessions.anonymous());

    expect(() =>
      contract.rule("unknown ID").forOperations({ ids: ["missing"] }),
    ).toThrow('Unknown operation ID "missing"');
    expect(() =>
      contract.rule("unknown tag").forOperations({ tags: ["missing"] }),
    ).toThrow('Unknown operation tag "missing"');
  });
});

class RecordingHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly events: string[]) {}

  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.events.push(`request:${request.path}`);
    this.requests.push(request);
    return { status: 200, headers: {}, body: { ok: true } };
  }
}

describe("authoring execution", () => {
  it("creates, acquires a session, requests once, and disposes for every case", async () => {
    const events: string[] = [];
    let fixtureId = 0;
    let sessionCalls = 0;
    const executionLifecycle = {
      async create(): Promise<Fixture> {
        fixtureId += 1;
        events.push(`create:${fixtureId}`);
        return {
          id: fixtureId,
          token: `token-${fixtureId}`,
          deviceId: `device-${fixtureId}`,
        };
      },
      async dispose(fixture: Fixture): Promise<void> {
        events.push(`dispose:${fixture.id}`);
      },
    };
    const contract = authorizationContract({
      name: "execution",
      baseUrl: () => "http://127.0.0.1",
      error: { code: () => undefined },
      lifecycle: executionLifecycle,
    }).actor(
      "member",
      sessions.fromHeaders(async ({ fixture }) => {
        sessionCalls += 1;
        events.push(`session:${fixture.id}`);
        return { "X-Session": fixture.token };
      }),
    );
    contract.case("first").as("member").get("/first").expectStatus(200);
    contract.case("second").as("member").post("/second").expectStatus(200);
    const cases = contract.build();
    const client = new RecordingHttpClient(events);

    const report = await runAuthorizationCases({
      suiteId: "execution",
      cases,
      lifecycle: executionLifecycle,
      httpClient: client,
    });

    expect(report.outcome).toBe("passed");
    expect(client.requests).toEqual([
      {
        method: "GET",
        path: "/first",
        headers: { "X-Session": "token-1" },
      },
      {
        method: "POST",
        path: "/second",
        headers: { "X-Session": "token-2" },
      },
    ]);
    expect(sessionCalls).toBe(2);
    expect(events).toEqual([
      "create:1",
      "session:1",
      "request:/first",
      "dispose:1",
      "create:2",
      "session:2",
      "request:/second",
      "dispose:2",
    ]);
  });

  it("runs a built contract through the public fetch-backed entry point", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requestCount += 1;
        return Response.json({
          authorization: request.headers.get("authorization"),
        });
      },
    });
    const contract = authorizationContract({
      name: "public-runner",
      baseUrl: () => server.url,
      error: { code: () => undefined },
      lifecycle,
    }).actor(
      "member",
      sessions.bearer(({ fixture }) => fixture.token),
    );
    contract
      .case("request")
      .as("member")
      .get("/request")
      .expectBody({ authorization: "Bearer fixture-token" });

    try {
      const report = await runAuthorizationTests(contract.build());
      expect(report.outcome).toBe("passed");
      expect(requestCount).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
});

function awaitFixture(): Fixture {
  return { id: 1, token: "token", deviceId: "device" };
}
