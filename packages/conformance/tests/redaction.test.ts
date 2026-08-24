import { describe, expect, it } from "bun:test";
import { SensitiveValueRedactor } from "../src/index.ts";

describe(SensitiveValueRedactor.name, () => {
  it("redacts credential families in text, paths, nested values, and database URLs", () => {
    const redactor = new SensitiveValueRedactor();
    const text = [
      "Authorization: Bearer bearer-secret",
      "Authorization: Basic basic-secret",
      'Authorization: Digest username="tester", response="digest-auth-secret"',
      "Cookie: session=session-secret; csrf=csrf-secret",
      "password=password-secret; reset_token=reset-secret; verification_token=verify-secret; user_code=user-secret; device_code=device-secret; digest=digest-secret; postgresql://tester:database-secret@localhost/auth",
    ].join("\n");

    const redactedText = redactor.redactText(text);

    for (const secret of [
      "bearer-secret",
      "basic-secret",
      "digest-auth-secret",
      "session-secret",
      "csrf-secret",
      "password-secret",
      "reset-secret",
      "verify-secret",
      "user-secret",
      "device-secret",
      "digest-secret",
      "database-secret",
    ]) {
      expect(redactedText).not.toContain(secret);
    }
    expect(
      redactor.redactPath("/token?device_code=path-secret&safe=value"),
    ).toBe("/token?device_code=[REDACTED]&safe=value");
    expect(
      redactor.redactValue({
        password: "nested-secret",
        safe: { authorization: "Bearer another-secret", message: "visible" },
      }),
    ).toEqual({
      password: "[REDACTED]",
      safe: { authorization: "[REDACTED]", message: "visible" },
    });
  });

  it("redacts sensitive keys embedded in serialized JSON text", () => {
    const redactor = new SensitiveValueRedactor();
    const sensitiveValues = [
      ["access_token", "access-canary"],
      ["refresh-token", "refresh-canary"],
      ["user_code", "user-code-canary"],
      ["device-code", "device-code-canary"],
      ["cookie", "cookie-canary"],
      ["digest", "digest-canary"],
      ["database_url", "postgresql://suite:database-canary@localhost/test"],
    ] as const;
    const serialized = JSON.stringify(Object.fromEntries(sensitiveValues));

    const redacted = redactor.redactText(`failure payload: ${serialized}`);

    for (const [, value] of sensitiveValues) {
      expect(redacted).not.toContain(value);
    }
    for (const [key] of sensitiveValues) {
      expect(redacted).toContain(`"${key}":"[REDACTED]"`);
    }
  });

  it("redacts sensitive keys in JSON arrays and nested serialized JSON", () => {
    const redactor = new SensitiveValueRedactor();

    expect(
      redactor.redactText(
        '[{"access_token":"array-access-canary"},"{\\"user_code\\":\\"nested-user-canary\\"}"]',
      ),
    ).toBe(
      '[{"access_token":"[REDACTED]"},"{\\"user_code\\":\\"[REDACTED]\\"}"]',
    );
    expect(
      redactor.redactText(
        '"{\\"credential\\":\\"double-serialized-canary\\"}"',
      ),
    ).toBe('"{\\"credential\\":\\"[REDACTED]\\"}"');
  });

  it.each([
    ["Date", new Date("2026-01-01T00:00:00.000Z")],
    ["Map", new Map([["access_token", "map-secret"]])],
    ["URL", new URL("https://example.test/?access_token=url-secret")],
    ["Error", new Error("password=error-secret")],
  ])(
    "rejects unsupported %s instances instead of flattening them",
    (_name, value) => {
      const redactor = new SensitiveValueRedactor();

      expect(() => redactor.redactValue(value)).toThrow(
        "SensitiveValueRedactor only accepts JSON-compatible plain values",
      );
    },
  );
});
