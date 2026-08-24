import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages", "conformance");

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();
  const exitCode = await process.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    throw new Error(
      [`Command failed: ${command.join(" ")}`, stdout, stderr]
        .filter((part) => part.trim() !== "")
        .join("\n"),
    );
  }

  return stdout.trim();
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function assertTarballContents(tarballPath: string): Promise<void> {
  const tarOutput = await run(["tar", "-tzf", tarballPath], repositoryRoot);
  const actualFiles = tarOutput
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"))
    .sort();

  const distRoot = join(packageRoot, "dist");
  const distFiles = await listFiles(distRoot);
  const expectedFiles = [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    ...distFiles.map(
      (file) =>
        `package/dist/${relative(distRoot, file).replaceAll("\\", "/")}`,
    ),
  ].sort();

  const missingFiles = expectedFiles.filter(
    (file) => !actualFiles.includes(file),
  );
  const unexpectedFiles = actualFiles.filter(
    (file) => !expectedFiles.includes(file),
  );

  if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
    throw new Error(
      [
        "Packed tarball contents did not match the package allowlist.",
        `Missing: ${missingFiles.join(", ") || "none"}`,
        `Unexpected: ${unexpectedFiles.join(", ") || "none"}`,
      ].join("\n"),
    );
  }

  const requiredArtifacts = [
    "package/dist/authoring.js",
    "package/dist/authoring.d.ts",
    "package/dist/authoring.js.map",
  ];
  for (const artifact of requiredArtifacts) {
    if (!actualFiles.includes(artifact)) {
      throw new Error(`Packed tarball is missing ${artifact}`);
    }
  }
}

const runtimeSource = `import { createServer } from "node:http";
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
    baseUrl: () => \`http://127.0.0.1:\${address.port}\`,
    lifecycle,
  })
    .actor("anonymous", sessions.anonymous())
    .actor("member", sessions.bearer(({ fixture }) => fixture.token));

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
      path: \`/custom/\${encodeURIComponent(fixture.deviceId)}\`,
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

  const report = await runAuthorizationTests(contract.build());
  if (report.outcome !== "passed" || report.summary.passed !== 3) {
    throw new Error(\`Packed consumer failed: \${JSON.stringify(report)}\`);
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
`;

const negativeTypeSource = `import {
  authorizationContract,
  sessions,
} from "@auth-conformance/core";

// @ts-expect-error Internal engine primitives are not public package exports.
import { Actor, AuthorizationCase, Operation } from "@auth-conformance/core";
// @ts-expect-error Package subpaths are closed by the exports map.
import "@auth-conformance/core/model";

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
}).actor("member", sessions.bearer(({ fixture }) => fixture.token));

// @ts-expect-error Actor names narrow to actors registered on this contract.
contract.case("unknown actor").as("administrator");
// @ts-expect-error A parameterized path requires every path parameter.
contract.case("missing param").as("member").get("/devices/:deviceId");
contract.case("extra param").as("member").get("/devices/:deviceId", {
  params: {
    deviceId: "device-1",
    // @ts-expect-error A parameterized path rejects unused path parameters.
    extra: "unused",
  },
});
// @ts-expect-error Coded errors require a configured envelope reader.
contract.case("coded error").as("member").get("/devices").expectError(403, "FORBIDDEN");

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
}).actor("member", sessions.bearer(({ fixture }) => fixture.token));

configuredContract
  .case("coded error")
  .as("member")
  .get("/devices")
  .expectError(403, "FORBIDDEN");
`;

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "auth-conformance-package-"),
  );
  const packedDirectory = join(temporaryRoot, "packed");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const sourceDirectory = join(consumerDirectory, "src");

  try {
    await mkdir(packedDirectory);
    await mkdir(sourceDirectory, { recursive: true });

    const tarballName = "auth-conformance-core-0.1.0.tgz";
    await run(
      ["bun", "pm", "pack", "--destination", packedDirectory, "--quiet"],
      packageRoot,
    );
    const tarballPath = join(packedDirectory, tarballName);
    await assertTarballContents(tarballPath);

    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "auth-conformance-packed-consumer",
          private: true,
          type: "module",
          dependencies: {
            "@auth-conformance/core": `file:${tarballPath}`,
          },
          devDependencies: {
            "@types/node": "26.3.0",
            typescript: "7.0.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            verbatimModuleSyntax: true,
            rootDir: "src",
            outDir: "dist",
            types: ["node"],
            skipLibCheck: false,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(sourceDirectory, "runtime.ts"), runtimeSource);
    await writeFile(
      join(sourceDirectory, "negative-types.ts"),
      negativeTypeSource,
    );

    await run(["bun", "install"], consumerDirectory);
    await run(["bun", "x", "tsc", "-p", "tsconfig.json"], consumerDirectory);
    await run(["node", "dist/runtime.js"], consumerDirectory);

    console.log(
      "Packed @auth-conformance/core installed, typechecked, and ran in an isolated Node consumer.",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
