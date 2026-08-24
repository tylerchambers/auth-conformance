import { inspect, isDeepStrictEqual } from "node:util";
import { ExpectedResponse, type ResponseMismatch } from "./model.ts";

export type ErrorEnvelope = {
  readonly code: (body: unknown) => unknown;
};

export type CaseAssertion<Fixture> = (input: {
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
  readonly fixture: Fixture;
}) => void | Promise<void>;

export function strictBodyExpectation(value: unknown): ExpectedResponse {
  return new ExpectedResponse({
    description: `expected body equal to ${formatValue(value)}`,
    evaluate: (response) =>
      isDeepStrictEqual(response.body, value)
        ? []
        : [
            policyMismatch(
              `expected response body ${formatValue(value)}, received ${formatValue(response.body)}`,
            ),
          ],
  });
}

export function containingBodyExpectation(subset: unknown): ExpectedResponse {
  return new ExpectedResponse({
    description: `expected body containing ${formatValue(subset)}`,
    evaluate: (response) =>
      isDeepSubset(response.body, subset)
        ? []
        : [
            policyMismatch(
              `expected response body containing ${formatValue(subset)}, received ${formatValue(response.body)}`,
            ),
          ],
  });
}

export function noContentExpectation(): ExpectedResponse {
  return new ExpectedResponse({
    description: "HTTP 204 with no response body",
    evaluate: (response) => {
      const mismatches: ResponseMismatch[] = [];
      if (response.status !== 204) {
        mismatches.push(
          policyMismatch(`expected HTTP 204, received HTTP ${response.status}`),
        );
      }
      if (response.body !== undefined) {
        mismatches.push(
          policyMismatch(
            `expected no response body, received ${formatValue(response.body)}`,
          ),
        );
      }
      return mismatches;
    },
  });
}

export function errorExpectation(
  envelope: ErrorEnvelope | undefined,
  status: number,
  code: string | undefined,
): ExpectedResponse {
  if (code !== undefined && envelope === undefined) {
    throw new Error(
      "An error code expectation requires an error-envelope configuration",
    );
  }
  return new ExpectedResponse({
    description:
      code === undefined ? `HTTP ${status}` : `HTTP ${status} error ${code}`,
    evaluate: (response) => {
      const mismatches: ResponseMismatch[] = [];
      if (response.status !== status) {
        mismatches.push(
          policyMismatch(
            `expected HTTP ${status}, received HTTP ${response.status}`,
          ),
        );
      }
      if (code !== undefined) {
        if (envelope === undefined) {
          throw new Error(
            "An error code expectation requires an error-envelope configuration",
          );
        }
        const actualCode = envelope.code(response.body);
        if (!isDeepStrictEqual(actualCode, code)) {
          mismatches.push(
            policyMismatch(
              `expected error code ${formatValue(code)}, received ${formatValue(actualCode)}`,
            ),
          );
        }
      }
      return mismatches;
    },
  });
}

export function callbackExpectation<Fixture>(
  assertion: CaseAssertion<Fixture>,
): ExpectedResponse {
  return new ExpectedResponse({
    description: "custom response assertion",
    async evaluate(response, fixture) {
      try {
        await assertion({
          response,
          fixture: fixtureFromRunner<Fixture>(fixture),
        });
        return [];
      } catch (error) {
        return [policyMismatch(errorMessage(error))];
      }
    },
  });
}

function fixtureFromRunner<Fixture>(fixture: unknown): Fixture {
  if (fixture === undefined) {
    throw new Error(
      "The runner did not provide a fixture to the case assertion",
    );
  }
  // The authorization contract and runner carry the same Fixture type parameter.
  return fixture as Fixture;
}

function policyMismatch(message: string): ResponseMismatch {
  return { kind: "policy", message };
}

function isDeepSubset(actual: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(actual, expected)) {
    return true;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length <= actual.length &&
      expected.every((entry, index) => isDeepSubset(actual[index], entry))
    );
  }
  if (!isPlainRecord(expected) || !isPlainRecord(actual)) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) && isDeepSubset(actual[key], value),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatValue(value: unknown): string {
  return inspect(value, { depth: null, sorted: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
