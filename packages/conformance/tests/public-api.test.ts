import { expect, it } from "bun:test";
import * as publicApi from "@auth-conformance/core";

it("exports only the section-two authoring surface", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "authorizationContract",
    "fromOpenApi",
    "runAuthorizationTests",
    "sessions",
  ]);
});
