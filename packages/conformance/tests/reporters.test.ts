import { describe, expect, it } from "bun:test";
import {
  ConsoleReporter,
  JsonReporter,
  type SuiteReport,
  type TextOutput,
} from "../src/index.ts";

class RecordingOutput implements TextOutput {
  readonly writes: string[] = [];

  write(value: string): void {
    this.writes.push(value);
  }
}

const report: SuiteReport = {
  suiteId: "devices",
  outcome: "failed",
  summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
  cases: [
    {
      caseId: "z-pass",
      actorName: "user-b",
      operationId: "listDevices",
      method: "GET",
      path: "/v1/devices",
      outcome: "passed",
      expected: "HTTP 200",
      actual: "HTTP 200",
      failures: [],
    },
    {
      caseId: "a-fail",
      actorName: "user-a",
      operationId: "renameDevice",
      method: "PATCH",
      path: "/v1/devices/foreign?access_token=secret-token",
      outcome: "failed",
      expected: "HTTP 404",
      actual: "HTTP 403",
      failures: [
        {
          category: "policy-mismatch",
          message: "received cookie=session-secret",
        },
      ],
    },
  ],
  failures: [],
};

describe("suite reporters", () => {
  it("console reporter emits compact sorted redacted failures", () => {
    const output = new RecordingOutput();

    new ConsoleReporter({ output }).report(report);

    expect(output.writes).toEqual([
      "FAIL devices (1/2 passed, 1 failed, 0 skipped)\n" +
        "  FAIL a-fail [user-a] PATCH /v1/devices/foreign?access_token=[REDACTED] renameDevice — expected HTTP 404; actual HTTP 403; policy-mismatch: received cookie=[REDACTED]\n",
    ]);
  });

  it("JSON reporter emits deterministic sorted redacted output", () => {
    const firstOutput = new RecordingOutput();
    const secondOutput = new RecordingOutput();

    new JsonReporter({ output: firstOutput }).report(report);
    new JsonReporter({ output: secondOutput }).report({
      ...report,
      cases: [...report.cases].reverse(),
    });

    expect(firstOutput.writes).toEqual(secondOutput.writes);
    expect(firstOutput.writes).toHaveLength(1);
    const serialized = firstOutput.writes[0];
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("session-secret");
    expect(JSON.parse(serialized ?? "")).toEqual({
      suiteId: "devices",
      outcome: "failed",
      summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
      cases: [
        {
          caseId: "a-fail",
          actorName: "user-a",
          operationId: "renameDevice",
          method: "PATCH",
          path: "/v1/devices/foreign?access_token=[REDACTED]",
          outcome: "failed",
          expected: "HTTP 404",
          actual: "HTTP 403",
          failures: [
            {
              category: "policy-mismatch",
              message: "received cookie=[REDACTED]",
            },
          ],
        },
        report.cases[0],
      ],
      failures: [],
    });
  });

  it("console and JSON reporters redact serialized sensitive failures", () => {
    const consoleOutput = new RecordingOutput();
    const jsonOutput = new RecordingOutput();
    const sensitiveReport: SuiteReport = {
      ...report,
      failures: [
        {
          category: "framework-defect",
          message: JSON.stringify([
            { device_code: "report-device-canary" },
            JSON.stringify({ credential: "nested-report-canary" }),
          ]),
        },
      ],
    };

    new ConsoleReporter({ output: consoleOutput }).report(sensitiveReport);
    new JsonReporter({ output: jsonOutput }).report(sensitiveReport);

    for (const output of [consoleOutput, jsonOutput]) {
      expect(output.writes.join("\n")).not.toContain("report-device-canary");
      expect(output.writes.join("\n")).not.toContain("nested-report-canary");
      expect(output.writes.join("\n")).toContain("[REDACTED]");
    }
  });
});
