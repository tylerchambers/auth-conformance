import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages", "conformance");
const consumerFixtureRoot = join(repositoryRoot, "scripts", "package-consumer");

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

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "auth-conformance-package-"),
  );
  const packedDirectory = join(temporaryRoot, "packed");
  const consumerDirectory = join(temporaryRoot, "consumer");

  try {
    await mkdir(packedDirectory);
    await cp(consumerFixtureRoot, consumerDirectory, { recursive: true });

    const tarballPath = join(packedDirectory, "package.tgz");
    await run(
      ["bun", "pm", "pack", "--filename", tarballPath, "--quiet"],
      packageRoot,
    );
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
