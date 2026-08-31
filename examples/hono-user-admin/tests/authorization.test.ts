import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  authorizationContract,
  fromOpenApi,
  runAuthorizationTests,
  sessions,
} from "auth-conformance";
import openApiDocument from "../openapi.json";
import { startServer, type UserAdminServer } from "../src/server.ts";

type Fixture = {
  readonly adminToken: string;
  readonly fixtureId: string;
  readonly invalidSessionId: string;
  readonly otherUserId: string;
  readonly ownUserId: string;
  readonly sessionId: string;
  readonly updatedDisplayName: string;
  readonly userToken: string;
};

async function provisionFixture(baseUrl: string): Promise<Fixture> {
  const response = await fetch(`${baseUrl}/test/fixtures`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userCount: 2 }),
  });
  const body: unknown = await response.json();
  if (
    response.status !== 201 ||
    body === null ||
    typeof body !== "object" ||
    !("adminToken" in body) ||
    typeof body.adminToken !== "string" ||
    !("fixtureId" in body) ||
    typeof body.fixtureId !== "string" ||
    !("invalidSessionId" in body) ||
    typeof body.invalidSessionId !== "string" ||
    !("otherUserId" in body) ||
    typeof body.otherUserId !== "string" ||
    !("ownUserId" in body) ||
    typeof body.ownUserId !== "string" ||
    !("sessionId" in body) ||
    typeof body.sessionId !== "string" ||
    !("userToken" in body) ||
    typeof body.userToken !== "string"
  ) {
    throw new Error(
      `Fixture provisioning failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return {
    adminToken: body.adminToken,
    fixtureId: body.fixtureId,
    invalidSessionId: body.invalidSessionId,
    otherUserId: body.otherUserId,
    ownUserId: body.ownUserId,
    sessionId: body.sessionId,
    updatedDisplayName: `Updated ${body.fixtureId}`,
    userToken: body.userToken,
  };
}

async function disposeFixture(
  baseUrl: string,
  fixtureId: string,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/test/fixtures/${encodeURIComponent(fixtureId)}`,
    { method: "DELETE" },
  );
  if (response.status !== 204) {
    throw new Error(
      `Fixture disposal failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
}

let server: UserAdminServer;

beforeAll(() => {
  server = startServer(0);
});

afterAll(async () => {
  await server.stop();
});

test("the user and admin authorization contract passes", async () => {
  const contract = authorizationContract<Fixture>({
    name: "hono-user-admin",
    baseUrl: () => server.url,
    operations: fromOpenApi(openApiDocument),
    lifecycle: {
      async create() {
        return provisionFixture(server.url);
      },
      async dispose(fixture) {
        await disposeFixture(server.url, fixture.fixtureId);
      },
    },
  })
    .actor("anonymous", sessions.anonymous())
    .actor(
      "raw-token",
      sessions.fromHeaders(({ fixture }) => ({
        Authorization: fixture.userToken,
      })),
    )
    .actor(
      "user",
      sessions.bearer(({ fixture }) => fixture.userToken),
    )
    .actor(
      "admin",
      sessions.bearer(({ fixture }) => fixture.adminToken),
    )
    .actor(
      "cookie-user",
      sessions.cookies(({ fixture }) => ({ session: fixture.sessionId })),
    )
    .actor(
      "invalid-cookie",
      sessions.cookies(({ fixture }) => ({
        session: fixture.invalidSessionId,
      })),
    );

  contract
    .case("anonymous callers cannot read a user")
    .as("anonymous")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.ownUserId },
    })
    .expectError(401);

  contract
    .case("raw tokens without a Bearer scheme are rejected")
    .as("raw-token")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.ownUserId },
    })
    .expectError(401);

  contract
    .case("users can read their own resource")
    .as("user")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.ownUserId },
    })
    .expectResponse(({ fixture }) => ({
      status: 200,
      body: { id: fixture.ownUserId },
    }));

  contract
    .case("cookie sessions can read their own resource")
    .as("cookie-user")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.ownUserId },
    })
    .expectResponse(({ fixture }) => ({
      status: 200,
      body: { id: fixture.ownUserId },
    }));

  contract
    .case("invalid cookie sessions are rejected")
    .as("invalid-cookie")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.ownUserId },
    })
    .expectError(401);

  contract
    .case("users cannot discover another user's resource")
    .as("user")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.otherUserId },
    })
    .expectError(404);

  contract
    .case("admins can read another user's resource")
    .as("admin")
    .get("/users/:userId", {
      params: { userId: ({ fixture }) => fixture.otherUserId },
    })
    .expectResponse(({ fixture }) => ({
      status: 200,
      body: { id: fixture.otherUserId },
    }));

  contract
    .case("users can update their own resource")
    .as("user")
    .request("PATCH", ({ fixture }) => ({
      path: `/users/${encodeURIComponent(fixture.ownUserId)}`,
      body: { displayName: fixture.updatedDisplayName },
    }))
    .expectResponse(({ fixture }) => ({
      status: 200,
      headers: { "X-Resource-State": "updated" },
      body: {
        id: fixture.ownUserId,
        displayName: fixture.updatedDisplayName,
      },
    }));

  contract
    .rule("users cannot access admin operations")
    .forOperations({ tags: ["admin"] })
    .as("user")
    .expectError(403);

  contract
    .case("admins can read the admin audit summary")
    .as("admin")
    .get("/admin/audit")
    .expectResponse({
      status: 200,
      body: { activeUsers: 2 },
    });

  const report = await runAuthorizationTests(contract.build());

  if (report.outcome !== "passed") {
    throw new Error(JSON.stringify(report, null, 2));
  }
  expect(report.summary.passed).toBe(10);
});
