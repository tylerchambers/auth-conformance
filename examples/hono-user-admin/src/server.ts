import { Hono } from "hono";
import { getCookie } from "hono/cookie";

type Principal =
  | { readonly role: "admin" }
  | { readonly role: "user"; readonly userId: string };

type User = {
  readonly id: string;
  readonly displayName?: string;
};

type FixtureRecord = {
  readonly bearerTokens: readonly string[];
  readonly sessionId: string;
  readonly userIds: readonly string[];
};

type AppState = {
  readonly bearerPrincipals: Map<string, Principal>;
  readonly fixtures: Map<string, FixtureRecord>;
  readonly sessionPrincipals: Map<string, Principal>;
  readonly users: Map<string, User>;
  nextFixtureId: number;
};

function buildApp(state: AppState): Hono {
  const app = new Hono();

  app.post("/test/fixtures", async (context) => {
    const input: unknown = await context.req.json().catch(() => undefined);
    if (
      input === null ||
      typeof input !== "object" ||
      !("userCount" in input) ||
      input.userCount !== 2
    ) {
      return context.json({ error: "expected_two_users" }, 400);
    }

    state.nextFixtureId += 1;
    const fixtureId = `fixture-${state.nextFixtureId}`;
    const ownUserId = `${fixtureId}-owner`;
    const otherUserId = `${fixtureId}-other`;
    const userToken = `token-${ownUserId}`;
    const adminToken = `token-${fixtureId}-admin`;
    const sessionId = `session-${ownUserId}`;

    state.users.set(ownUserId, { id: ownUserId });
    state.users.set(otherUserId, { id: otherUserId });
    state.bearerPrincipals.set(userToken, {
      role: "user",
      userId: ownUserId,
    });
    state.bearerPrincipals.set(adminToken, { role: "admin" });
    state.sessionPrincipals.set(sessionId, {
      role: "user",
      userId: ownUserId,
    });
    state.fixtures.set(fixtureId, {
      bearerTokens: [userToken, adminToken],
      sessionId,
      userIds: [ownUserId, otherUserId],
    });

    return context.json(
      {
        adminToken,
        fixtureId,
        invalidSessionId: `invalid-${sessionId}`,
        otherUserId,
        ownUserId,
        sessionId,
        userToken,
      },
      201,
    );
  });

  app.delete("/test/fixtures/:fixtureId", (context) => {
    const fixtureId = context.req.param("fixtureId");
    const fixture = state.fixtures.get(fixtureId);
    if (fixture === undefined) {
      return context.json({ error: "fixture_not_found" }, 404);
    }
    for (const token of fixture.bearerTokens) {
      state.bearerPrincipals.delete(token);
    }
    for (const userId of fixture.userIds) {
      state.users.delete(userId);
    }
    state.sessionPrincipals.delete(fixture.sessionId);
    state.fixtures.delete(fixtureId);
    return context.body(null, 204);
  });

  app.get("/users/:userId", (context) => {
    const principal = authenticate(
      context.req.header("Authorization"),
      getCookie(context, "session"),
      state,
    );
    if (principal === undefined) {
      return context.json({ error: "unauthorized" }, 401);
    }

    const requestedUserId = context.req.param("userId");
    if (principal.role === "user" && requestedUserId !== principal.userId) {
      // Hide whether another user's resource exists.
      return context.json({ error: "not_found" }, 404);
    }

    const user = state.users.get(requestedUserId);
    return user === undefined
      ? context.json({ error: "not_found" }, 404)
      : context.json(user);
  });

  app.patch("/users/:userId", async (context) => {
    const principal = authenticate(
      context.req.header("Authorization"),
      getCookie(context, "session"),
      state,
    );
    if (principal === undefined) {
      return context.json({ error: "unauthorized" }, 401);
    }

    const requestedUserId = context.req.param("userId");
    if (principal.role === "user" && requestedUserId !== principal.userId) {
      return context.json({ error: "not_found" }, 404);
    }
    const user = state.users.get(requestedUserId);
    if (user === undefined) {
      return context.json({ error: "not_found" }, 404);
    }

    const input: unknown = await context.req.json().catch(() => undefined);
    if (
      input === null ||
      typeof input !== "object" ||
      !("displayName" in input) ||
      typeof input.displayName !== "string"
    ) {
      return context.json({ error: "invalid_display_name" }, 400);
    }

    const updatedUser = { ...user, displayName: input.displayName };
    state.users.set(user.id, updatedUser);
    context.header("X-Resource-State", "updated");
    return context.json(updatedUser);
  });

  app.get("/admin/audit", (context) => {
    const principal = authenticate(
      context.req.header("Authorization"),
      getCookie(context, "session"),
      state,
    );
    if (principal === undefined) {
      return context.json({ error: "unauthorized" }, 401);
    }
    if (principal.role !== "admin") {
      return context.json({ error: "forbidden" }, 403);
    }

    return context.json({ activeUsers: state.users.size });
  });

  return app;
}

function authenticate(
  authorization: string | undefined,
  sessionId: string | undefined,
  state: AppState,
): Principal | undefined {
  if (authorization !== undefined) {
    const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
    const token = match?.[1];
    return token === undefined ? undefined : state.bearerPrincipals.get(token);
  }
  return sessionId === undefined
    ? undefined
    : state.sessionPrincipals.get(sessionId);
}

export type UserAdminServer = {
  readonly url: string;
  stop(): Promise<void>;
};

/** Starts the example on loopback, using an ephemeral port when `port` is zero. */
export function startServer(port: number): UserAdminServer {
  const state: AppState = {
    bearerPrincipals: new Map(),
    fixtures: new Map(),
    nextFixtureId: 0,
    sessionPrincipals: new Map(),
    users: new Map(),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: buildApp(state).fetch,
  });

  return {
    url: server.url.origin,
    async stop() {
      await server.stop(true);
    },
  };
}
