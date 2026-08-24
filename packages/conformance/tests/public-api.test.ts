import { expect, it } from "bun:test";
import * as publicApi from "../src/authoring.ts";

it("exports only the section-two authoring surface", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "authorizationContract",
    "fromOpenApi",
    "runAuthorizationTests",
    "sessions",
  ]);
});
