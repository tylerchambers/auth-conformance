import { describe, expect, it } from "bun:test";
import {
  Actor,
  AuthorizationCase,
  AuthorizationCaseExpander,
  type AuthorizationInvariant,
  DuplicateAuthorizationCaseIdError,
  ExpectedResponse,
  Operation,
  ResourceReference,
} from "../src/index.ts";

type Fixture = { readonly deviceId: string };

const anonymous = new Actor<Fixture>({
  name: "anonymous",
  authentication: "anonymous",
});
const ok = ExpectedResponse.status(200);

function testCase(id: string): AuthorizationCase<Fixture> {
  return new AuthorizationCase({
    id,
    actor: anonymous,
    operation: new Operation({
      id: "getDevice",
      method: "GET",
      buildRequest: (fixture) => ({
        path: `/v1/devices/${fixture.deviceId}`,
      }),
    }),
    expectedResponse: ok,
  });
}

describe(AuthorizationCaseExpander.name, () => {
  it("resolves typed resource references from the current fixture", () => {
    const reference = new ResourceReference<Fixture, string>({
      id: "user-a-device",
      resolve: (fixture) => fixture.deviceId,
    });

    expect(reference.resolve({ deviceId: "device-123" })).toBe("device-123");
  });

  it("assembles the operation-owned method into each request", () => {
    const operation = testCase("devices.get").operation;

    expect(operation.buildRequest({ deviceId: "device-123" })).toEqual({
      method: "GET",
      path: "/v1/devices/device-123",
    });
  });

  it("expands invariants into stable case-id order without mutating declarations", () => {
    const declaredCases = [
      testCase("devices.ä-unicode"),
      testCase("devices.z-last"),
      testCase("devices.a-first"),
    ];
    const invariant: AuthorizationInvariant<Fixture> = {
      id: "device-visibility",
      expand: () => declaredCases,
    };

    const expanded = new AuthorizationCaseExpander().expand([invariant]);

    expect(expanded.map(({ id }) => id)).toEqual([
      "devices.a-first",
      "devices.z-last",
      "devices.ä-unicode",
    ]);
    expect(declaredCases.map(({ id }) => id)).toEqual([
      "devices.ä-unicode",
      "devices.z-last",
      "devices.a-first",
    ]);
  });

  it("rejects duplicate case IDs across invariants", () => {
    const first: AuthorizationInvariant<Fixture> = {
      id: "first",
      expand: () => [testCase("devices.duplicate")],
    };
    const second: AuthorizationInvariant<Fixture> = {
      id: "second",
      expand: () => [testCase("devices.duplicate")],
    };

    expect(() =>
      new AuthorizationCaseExpander().expand([first, second]),
    ).toThrow(new DuplicateAuthorizationCaseIdError("devices.duplicate"));
  });
});
