import { isDeepStrictEqual } from "node:util";
import { authorizationContract, sessions } from "../../src/authoring.ts";

export type HistoricalOracleFixture = {
  readonly instance: number;
  readonly events?: string[];
};

type OracleLifecycle = {
  create(): Promise<HistoricalOracleFixture>;
  dispose(fixture: HistoricalOracleFixture): Promise<void>;
};

type OracleSession = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
};

type OracleSessionFactory = (context: {
  readonly fixture: HistoricalOracleFixture;
}) => OracleSession | Promise<OracleSession>;

export function createHistoricalOracleLifecycle(
  events: string[],
): OracleLifecycle {
  let nextInstance = 0;
  return {
    async create() {
      nextInstance += 1;
      events.push(`create:${nextInstance}`);
      return { instance: nextInstance, events };
    },
    async dispose(fixture) {
      events.push(`dispose:${fixture.instance}`);
    },
  };
}

function recordedSession(
  actor: string,
  factory: OracleSessionFactory,
): OracleSessionFactory {
  return async (context) => {
    context.fixture.events?.push(
      `session:${context.fixture.instance}:${actor}`,
    );
    return factory(context);
  };
}

function readErrorCode(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  if ("code" in body) {
    return body.code;
  }
  if ("error" in body) {
    return body.error;
  }
  return undefined;
}

function strictResponse(
  status: number,
  body: unknown,
): (input: {
  readonly response: { readonly status: number; readonly body: unknown };
}) => void {
  return ({ response }) => {
    if (response.status !== status) {
      throw new Error(
        `expected HTTP ${status}, received HTTP ${response.status}`,
      );
    }
    if (!isDeepStrictEqual(response.body, body)) {
      throw new Error(
        "response body did not strictly match the historical oracle",
      );
    }
  };
}

export function buildHistoricalOracleContract(
  lifecycle: OracleLifecycle = createHistoricalOracleLifecycle([]),
) {
  const contract = authorizationContract({
    name: "historical-authorization-oracle",
    baseUrl: () => "http://127.0.0.1",
    error: { code: readErrorCode },
    lifecycle,
  })
    .actor(
      "anonymous",
      recordedSession(
        "anonymous",
        sessions.anonymous<HistoricalOracleFixture>(),
      ),
    )
    .actor(
      "userA",
      recordedSession(
        "userA",
        sessions.fromHeaders<HistoricalOracleFixture>(() => ({
          Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        })),
      ),
    )
    .actor(
      "userB",
      recordedSession(
        "userB",
        sessions.fromHeaders<HistoricalOracleFixture>(() => ({
          Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERB>",
        })),
      ),
    )
    .actor(
      "revokedUser",
      recordedSession(
        "revokedUser",
        sessions.fromHeaders<HistoricalOracleFixture>(() => ({
          Cookie:
            "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_REVOKEDUSER>",
        })),
      ),
    )
    .actor(
      "nonAdmin",
      recordedSession(
        "nonAdmin",
        sessions.fromHeaders<HistoricalOracleFixture>(() => ({
          Cookie:
            "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_NONADMIN>",
        })),
      ),
    )
    .actor(
      "adminWithoutBeta",
      recordedSession(
        "adminWithoutBeta",
        sessions.fromHeaders<HistoricalOracleFixture>(() => ({
          Cookie:
            "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
        })),
      ),
    )
    .actor(
      "cliBearerA",
      recordedSession(
        "cliBearerA",
        sessions.bearer<HistoricalOracleFixture>("<CLI_BEARER_A>"),
      ),
    );
  contract
    .case("account me anonymous")
    .id("account.me.anonymous")
    .as("anonymous")
    .get("/v1/me")
    .expectThat(strictResponse(401, { code: "UNAUTHENTICATED" }));
  contract
    .case("account me cli bearer a")
    .id("account.me.cli-bearer-a")
    .as("cliBearerA")
    .get("/v1/me", { headers: { Authorization: "Bearer <CLI_BEARER_A>" } })
    .expectStatus(200);
  contract
    .case("account me revoked user")
    .id("account.me.revoked-user")
    .as("revokedUser")
    .get("/v1/me", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_REVOKEDUSER>",
      },
    })
    .expectThat(strictResponse(403, { code: "BETA_ACCESS_REQUIRED" }));
  contract
    .case("admin beta grant missing origin")
    .id("admin.beta.grant.missing-origin")
    .as("adminWithoutBeta")
    .put("/v1/admin/users/<NONEXISTENT_USER_ID>/beta-access", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
      },
    })
    .expectThat(strictResponse(403, { code: "INVALID_ADMIN_REQUEST" }));
  contract
    .case("admin beta grant non admin")
    .id("admin.beta.grant.non-admin")
    .as("nonAdmin")
    .put("/v1/admin/users/<USER_WITHOUT_BETA_ID>/beta-access", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_NONADMIN>",
        Origin: "<APP_ORIGIN>",
      },
    })
    .expectThat(strictResponse(403, { code: "ADMIN_ACCESS_REQUIRED" }));
  contract
    .case("admin beta revoke missing access")
    .id("admin.beta.revoke.missing-access")
    .as("adminWithoutBeta")
    .delete("/v1/admin/users/<USER_WITHOUT_BETA_ID>/beta-access", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
        Origin: "<APP_ORIGIN>",
      },
    })
    .expectThat(strictResponse(404, { code: "BETA_ACCESS_NOT_FOUND" }));
  contract
    .case("admin invitations create admin without beta")
    .id("admin.invitations.create.admin-without-beta")
    .as("adminWithoutBeta")
    .post("/v1/admin/invitations", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { email: "<REVOKED_INVITATION_EMAIL>" },
    })
    .expectStatus(200);
  contract
    .case("admin invitations create foreign origin")
    .id("admin.invitations.create.foreign-origin")
    .as("adminWithoutBeta")
    .post("/v1/admin/invitations", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
        Origin: "https://authorization-suite.invalid",
        "Content-Type": "application/json",
      },
      body: { email: "malformed-email" },
    })
    .expectThat(strictResponse(403, { code: "INVALID_ADMIN_REQUEST" }));
  contract
    .case("admin invitations create ordering anonymous")
    .id("admin.invitations.create.ordering.anonymous")
    .as("anonymous")
    .post("/v1/admin/invitations", {
      headers: { "Content-Type": "application/json" },
      body: { email: "malformed-email" },
    })
    .expectThat(strictResponse(401, { code: "UNAUTHENTICATED" }));
  contract
    .case("admin invitations revoke nonexistent")
    .id("admin.invitations.revoke.nonexistent")
    .as("adminWithoutBeta")
    .delete("/v1/admin/invitations/<NONEXISTENT_INVITATION_ID>", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
        Origin: "<APP_ORIGIN>",
      },
    })
    .expectThat(strictResponse(404, { code: "INVITATION_NOT_FOUND" }));
  contract
    .case("admin me admin without beta")
    .id("admin.me.admin-without-beta")
    .as("adminWithoutBeta")
    .get("/v1/admin/me", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_ADMINWITHOUTBETA>",
      },
    })
    .expectStatus(200);
  contract
    .case("admin me anonymous")
    .id("admin.me.anonymous")
    .as("anonymous")
    .get("/v1/admin/me")
    .expectThat(strictResponse(401, { code: "UNAUTHENTICATED" }));
  contract
    .case("admin me non admin")
    .id("admin.me.non-admin")
    .as("nonAdmin")
    .get("/v1/admin/me", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_NONADMIN>",
      },
    })
    .expectThat(strictResponse(403, { code: "ADMIN_ACCESS_REQUIRED" }));
  contract
    .case("devices rename user a owner")
    .id("devices.rename.user-a.owner")
    .as("userA")
    .patch("/v1/devices/<USER_A_DEVICE_ID>", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { nickname: "Renamed by owner" },
    })
    .expectStatus(200);
  contract
    .case("devices revoke user a foreign user b")
    .id("devices.revoke.user-a.foreign-user-b")
    .as("userA")
    .delete("/v1/devices/<USER_B_DEVICE_ID>", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
      },
    })
    .expectThat(strictResponse(404, { code: "DEVICE_NOT_FOUND" }));
  contract
    .case("pings accept browser user a")
    .id("pings.accept.browser-user-a")
    .as("userA")
    .post("/v1/pings", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        "Content-Type": "application/json",
        "Idempotency-Key": "authorization_suite_ping_123456",
      },
      body: { message: "Authorization suite ping" },
    })
    .expectThat(strictResponse(401, { code: "UNAUTHENTICATED" }));
  contract
    .case("pings accept cli bearer a")
    .id("pings.accept.cli-bearer-a")
    .as("cliBearerA")
    .post("/v1/pings", {
      headers: {
        Authorization: "Bearer <CLI_BEARER_A>",
        "Content-Type": "application/json",
        "Idempotency-Key": "authorization_suite_ping_123456",
      },
      body: { message: "Authorization suite ping" },
    })
    .expectStatus(202);
  contract
    .case("protocol approve foreign session")
    .id("protocol.approve.foreign-session")
    .as("userB")
    .post("/api/auth/device/approve", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERB>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<CLAIMED_USER_A_USER_CODE>", nickname: "Suite CLI" },
    })
    .expectError(400, "invalid_request");
  contract
    .case("protocol claim anonymous")
    .id("protocol.claim.anonymous")
    .as("anonymous")
    .post("/api/auth/device", {
      headers: { Origin: "<APP_ORIGIN>", "Content-Type": "application/json" },
      body: { userCode: "<PENDING_USER_CODE>" },
    })
    .expectError(401, "unauthorized");
  contract
    .case("protocol claim exact origin")
    .id("protocol.claim.exact-origin")
    .as("userA")
    .post("/api/auth/device", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<PENDING_USER_CODE>" },
    })
    .expectThat(
      strictResponse(200, {
        status: "pending",
        user_code: "<PENDING_USER_CODE>",
      }),
    );
  contract
    .case("protocol claim missing origin")
    .id("protocol.claim.missing-origin")
    .as("userA")
    .post("/api/auth/device", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<PENDING_USER_CODE>" },
    })
    .expectError(403, "invalid_request");
  contract
    .case("protocol claim revoked user")
    .id("protocol.claim.revoked-user")
    .as("revokedUser")
    .post("/api/auth/device", {
      headers: {
        Cookie:
          "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_REVOKEDUSER>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<PENDING_USER_CODE>" },
    })
    .expectError(403, "access_denied");
  contract
    .case("protocol deny active owner")
    .id("protocol.deny.active-owner")
    .as("userA")
    .post("/api/auth/device/deny", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<CLAIMED_USER_A_USER_CODE>" },
    })
    .expectThat(strictResponse(200, { success: true }));
  contract
    .case("protocol issue public safe shape")
    .id("protocol.issue.public-safe-shape")
    .as("anonymous")
    .post("/api/auth/device/code", {
      headers: { "Content-Type": "application/json" },
      body: { client_id: "ping-the-human-cli", scope: "openid profile email" },
    })
    .expectStatus(200);
  contract
    .case("protocol journey approve owner")
    .id("protocol.journey.approve-owner")
    .as("userA")
    .post("/api/auth/device", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: { userCode: "<PENDING_USER_CODE>" },
    })
    .expectThat(
      strictResponse(200, {
        status: "pending",
        user_code: "<PENDING_USER_CODE>",
      }),
    );
  contract
    .case("protocol poll pending safe error")
    .id("protocol.poll.pending-safe-error")
    .as("anonymous")
    .post("/api/auth/device/token", {
      headers: { "Content-Type": "application/json" },
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "<PENDING_DEVICE_CODE>",
        client_id: "ping-the-human-cli",
      },
    })
    .expectError(400, "authorization_pending");
  contract
    .case("protocol redeem approved once")
    .id("protocol.redeem.approved-once")
    .as("anonymous")
    .post("/api/auth/device/token", {
      headers: { "Content-Type": "application/json" },
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "<APPROVED_DEVICE_CODE>",
        client_id: "ping-the-human-cli",
      },
    })
    .expectStatus(200);
  contract
    .case("push register foreign origin")
    .id("push.register.foreign-origin")
    .as("userA")
    .put("/v1/push/destination", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "https://authorization-suite.invalid",
        "Content-Type": "application/json",
      },
      body: {
        endpoint: "https://push.example.test/subscriptions/<SUBSCRIPTION_ID>",
        keys: { auth: "<PUSH_AUTH>", p256dh: "<PUSH_P256DH>" },
      },
    })
    .expectThat(strictResponse(403, { code: "INVALID_PUSH_REQUEST" }));
  contract
    .case("push register user a")
    .id("push.register.user-a")
    .as("userA")
    .put("/v1/push/destination", {
      headers: {
        Cookie: "ping-the-human.session_token=<SIGNED_SESSION_TOKEN_USERA>",
        Origin: "<APP_ORIGIN>",
        "Content-Type": "application/json",
      },
      body: {
        endpoint: "https://push.example.test/subscriptions/<SUBSCRIPTION_ID>",
        keys: { auth: "<PUSH_AUTH>", p256dh: "<PUSH_P256DH>" },
      },
    })
    .expectNoContent();
  contract
    .case("session revoke cli bearer a")
    .id("session.revoke.cli-bearer-a")
    .as("cliBearerA")
    .delete("/v1/session", {
      headers: { Authorization: "Bearer <CLI_BEARER_A>" },
    })
    .expectNoContent();
  return contract.build();
}
