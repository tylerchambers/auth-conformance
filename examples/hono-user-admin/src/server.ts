import { Hono } from "hono";
import { getCookie } from "hono/cookie";

type Principal =
  | { readonly role: "admin" }
  | { readonly role: "user"; readonly userId: string };

const bearerPrincipals = new Map<string, Principal>([
  ["token-user-1", { role: "user", userId: "user-1" }],
  ["token-admin", { role: "admin" }],
]);
const users = new Map([
  ["user-1", { id: "user-1" }],
  ["user-2", { id: "user-2" }],
]);

function buildApp(sessionPrincipals: ReadonlyMap<string, Principal>): Hono {
  const app = new Hono();

  app.get("/users/:userId", (context) => {
    const principal = authenticate(
      context.req.header("Authorization"),
      getCookie(context, "session"),
      sessionPrincipals,
    );
    if (principal === undefined) {
      return context.json({ error: "unauthorized" }, 401);
    }

    const requestedUserId = context.req.param("userId");
    if (principal.role === "user" && requestedUserId !== principal.userId) {
      // Hide whether another user's resource exists.
      return context.json({ error: "not_found" }, 404);
    }

    const user = users.get(requestedUserId);
    return user === undefined
      ? context.json({ error: "not_found" }, 404)
      : context.json(user);
  });

  app.get("/admin/audit", (context) => {
    const principal = authenticate(
      context.req.header("Authorization"),
      getCookie(context, "session"),
      sessionPrincipals,
    );
    if (principal === undefined) {
      return context.json({ error: "unauthorized" }, 401);
    }
    if (principal.role !== "admin") {
      return context.json({ error: "forbidden" }, 403);
    }

    return context.json({ activeUsers: users.size });
  });

  return app;
}

function authenticate(
  authorization: string | undefined,
  sessionId: string | undefined,
  sessionPrincipals: ReadonlyMap<string, Principal>,
): Principal | undefined {
  if (authorization !== undefined) {
    const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
    const token = match?.[1];
    return token === undefined ? undefined : bearerPrincipals.get(token);
  }
  return sessionId === undefined ? undefined : sessionPrincipals.get(sessionId);
}

export type UserAdminServer = {
  readonly url: string;
  createUserSession(userId: string): string;
  deleteSession(sessionId: string): void;
  stop(): Promise<void>;
};

/** Starts the example on loopback, using an ephemeral port when `port` is zero. */
export function startServer(port: number): UserAdminServer {
  const sessionPrincipals = new Map<string, Principal>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: buildApp(sessionPrincipals).fetch,
  });

  return {
    url: server.url.origin,
    createUserSession(userId) {
      if (!users.has(userId)) {
        throw new RangeError(`Unknown user "${userId}"`);
      }
      const sessionId = `session-${userId}`;
      sessionPrincipals.set(sessionId, { role: "user", userId });
      return sessionId;
    },
    deleteSession(sessionId) {
      sessionPrincipals.delete(sessionId);
    },
    async stop() {
      await server.stop(true);
    },
  };
}
