const REDACTED = "[REDACTED]";

const ASSIGNED_SECRET =
  /\b(cookie|set-cookie|credential|password|passphrase|client_secret|authorization_test_database_url|database_url|access_token|refresh_token|reset_token|verification_token|user_code|device_code|digest)=([^\s,;&]+)/gi;

const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|credential|password|passphrase|client[_-]?secret|.*(?:token|digest)|(?:user|device)[_-]?code|.*database[_-]?url)$/i;

const JSON_SECRET =
  /("(?:authorization|cookie|set-cookie|credential|password|passphrase|client[_-]?secret|[^"]*(?:token|digest)|(?:user|device)[_-]?code|[^"]*database[_-]?url)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;

const UNSUPPORTED_VALUE_MESSAGE =
  "SensitiveValueRedactor only accepts JSON-compatible plain values";

/** Removes credential material from errors and retained observations. */
export class SensitiveValueRedactor {
  redactText(value: string): string {
    return (this.redactSerializedJson(value) ?? value)
      .replace(JSON_SECRET, `$1"${REDACTED}"`)
      .replace(/\bAuthorization\s*:[^\r\n]*/gi, `Authorization: ${REDACTED}`)
      .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
      .replace(
        /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
        (_match, name: string) => `${name}: ${REDACTED}`,
      )
      .replace(ASSIGNED_SECRET, (_match, name: string) => `${name}=${REDACTED}`)
      .replace(
        /\b(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
        (_match, prefix: string, _secret: string, suffix: string) =>
          `${prefix}${REDACTED}${suffix}`,
      );
  }

  private redactSerializedJson(value: string): string | undefined {
    try {
      const parsed: unknown = JSON.parse(value);
      return JSON.stringify(this.redactValue(parsed));
    } catch {
      return undefined;
    }
  }

  redactPath(path: string): string {
    const queryStart = path.indexOf("?");
    if (queryStart === -1) {
      return this.redactText(path);
    }

    const pathname = path.slice(0, queryStart);
    const parameters = new URLSearchParams(path.slice(queryStart + 1));
    for (const key of [...parameters.keys()]) {
      if (SENSITIVE_KEY.test(key)) {
        parameters.set(key, REDACTED);
      }
    }
    const query = parameters.toString().replaceAll("%5BREDACTED%5D", REDACTED);
    return this.redactText(`${pathname}?${query}`);
  }

  /** Redacts JSON-compatible primitives, arrays, and plain records only. */
  redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactValue(entry));
    }
    if (typeof value === "object" && this.isPlainRecord(value)) {
      const redacted: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        redacted[key] = SENSITIVE_KEY.test(key)
          ? REDACTED
          : this.redactValue(entry);
      }
      return redacted;
    }
    throw new TypeError(UNSUPPORTED_VALUE_MESSAGE);
  }

  private isPlainRecord(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
}
