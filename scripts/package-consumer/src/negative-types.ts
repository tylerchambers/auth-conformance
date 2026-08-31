import * as core from "auth-conformance";
// @ts-expect-error Package subpaths are closed by the exports map.
import "auth-conformance/model";

const { authorizationContract, sessions } = core;

// @ts-expect-error Internal engine primitives are not public package exports.
void core.Actor;
// @ts-expect-error Internal engine primitives are not public package exports.
void core.AuthorizationCase;
// @ts-expect-error Internal engine primitives are not public package exports.
void core.Operation;

type Fixture = {
  readonly token: string;
  readonly deviceId: string;
};

const lifecycle = {
  async create(): Promise<Fixture> {
    return { token: "token", deviceId: "device-1" };
  },
  async dispose(_fixture: Fixture): Promise<void> {},
};

const contract = authorizationContract({
  name: "negative-consumer-types",
  baseUrl: () => "http://127.0.0.1",
  lifecycle,
}).actor(
  "member",
  sessions.bearer(({ fixture }) => fixture.token),
);

// @ts-expect-error Actor names narrow to actors registered on this contract.
contract.case("unknown actor").as("administrator");
// @ts-expect-error A parameterized path requires every path parameter.
contract.case("missing param").as("member").get("/devices/:deviceId");
contract
  .case("extra param")
  .as("member")
  .get("/devices/:deviceId", {
    params: {
      deviceId: "device-1",
      // @ts-expect-error A parameterized path rejects unused path parameters.
      extra: "unused",
    },
  });
const statusOnlyCase = contract
  .case("coded error")
  .as("member")
  .get("/devices");
// @ts-expect-error Coded errors require a configured envelope reader.
statusOnlyCase.expectError(403, "FORBIDDEN");

const configuredContract = authorizationContract({
  name: "configured-error-consumer",
  baseUrl: () => "http://127.0.0.1",
  lifecycle,
  error: {
    code: (body) =>
      typeof body === "object" && body !== null && "code" in body
        ? body.code
        : undefined,
  },
}).actor(
  "member",
  sessions.bearer(({ fixture }) => fixture.token),
);

configuredContract
  .case("coded error")
  .as("member")
  .get("/devices")
  .expectError(403, "FORBIDDEN");
