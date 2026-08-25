import { createServer } from "node:http";
import {
  authorizationContract,
  runAuthorizationTests,
  sessions,
} from "@auth-conformance/core";

type Fixture = {
  readonly token: string;
  readonly deviceId: string;
};

const lifecycle = {
  async create(): Promise<Fixture> {
    return { token: "packed-token", deviceId: "device/1" };
  },
  async dispose(_fixture: Fixture): Promise<void> {},
};

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");

  response.setHeader("Content-Type", "application/json");
  if (request.url === "/forbidden") {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  if (request.url === "/devices/device%2F1") {
    response.end(
      JSON.stringify({
        authorization: request.headers.authorization,
        device: "device/1",
      }),
    );
    return;
  }
  if (request.url === "/custom/device%2F1" && request.method === "POST") {
    response.end(
      JSON.stringify({
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not-found" }));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Consumer server did not bind a TCP port");
  }

  const contract = authorizationContract({
    name: "packed-consumer",
    baseUrl: () => `http://127.0.0.1:${address.port}`,
    lifecycle,
  })
    .actor("anonymous", sessions.anonymous())
    .actor(
      "member",
      sessions.bearer(({ fixture }) => fixture.token),
    );

  contract
    .case("fixture path and actor")
    .as("member")
    .get("/devices/:deviceId", {
      params: { deviceId: ({ fixture }) => fixture.deviceId },
    })
    .expectBody({ authorization: "Bearer packed-token", device: "device/1" });

  contract
    .case("custom request")
    .as("member")
    .request("POST", ({ fixture }) => ({
      path: `/custom/${encodeURIComponent(fixture.deviceId)}`,
      body: { device: fixture.deviceId },
    }))
    .expectBody({
      authorization: "Bearer packed-token",
      body: { device: "device/1" },
    });

  contract
    .case("status-only error without envelope config")
    .as("anonymous")
    .get("/forbidden")
    .expectError(403);

  const report = await runAuthorizationTests(contract.build(), {
    signal: AbortSignal.timeout(30_000),
  });
  if (report.outcome !== "passed" || report.summary.passed !== 3) {
    throw new Error(`Packed consumer failed: ${JSON.stringify(report)}`);
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
