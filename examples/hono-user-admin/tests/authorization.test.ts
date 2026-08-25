import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  authorizationContract,
  fromOpenApi,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";
import openApiDocument from "../openapi.json";
import { startServer, type UserAdminServer } from "../src/server.ts";

type Fixture = {
  readonly adminToken: string;
  readonly otherUserId: string;
  readonly ownUserId: string;
  readonly userToken: string;
};

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
        return {
          adminToken: "token-admin",
          otherUserId: "user-2",
          ownUserId: "user-1",
          userToken: "token-user-1",
        };
      },
      async dispose() {},
    },
  })
    .actor("anonymous", sessions.anonymous())
    .actor(
      "user",
      sessions.bearer(({ fixture }) => fixture.userToken),
    )
    .actor(
      "admin",
      sessions.bearer(({ fixture }) => fixture.adminToken),
    );

  contract
    .case("anonymous callers cannot read a user")
    .as("anonymous")
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
    .expectBody({ id: "user-1" });

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
    .expectBody({ id: "user-2" });

  contract
    .rule("users cannot access admin operations")
    .forOperations({ tags: ["admin"] })
    .as("user")
    .expectError(403);

  contract
    .case("admins can read the admin audit summary")
    .as("admin")
    .get("/admin/audit")
    .expectBody({ activeUsers: 2 });

  const report = await runAuthorizationTests(contract.build());

  if (report.outcome !== "passed") {
    throw new Error(JSON.stringify(report, null, 2));
  }
  expect(report.summary.passed).toBe(6);
});
