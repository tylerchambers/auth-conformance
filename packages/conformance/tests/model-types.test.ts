import { describe, expect, it } from "bun:test";
import {
  Actor,
  type ActorOptions,
  type CaseReport,
  type CredentialProvider,
  type OperationOptions,
} from "../src/index.ts";

type Fixture = { readonly id: string };
type IsAssignable<TValue, TTarget> = [TValue] extends [TTarget] ? true : false;
type Assert<TValue extends true> = TValue;
type Not<TValue extends boolean> = TValue extends true ? false : true;

type AnonymousWithoutCredentialIsAllowed = Assert<
  IsAssignable<
    { readonly name: "anonymous"; readonly authentication: "anonymous" },
    ActorOptions<Fixture>
  >
>;
type AnonymousWithCredentialIsForbidden = Assert<
  Not<
    IsAssignable<
      {
        readonly name: "anonymous";
        readonly authentication: "anonymous";
        readonly credentialProvider: CredentialProvider<Fixture>;
      },
      ActorOptions<Fixture>
    >
  >
>;
type BrowserWithCredentialIsAllowed = Assert<
  IsAssignable<
    {
      readonly name: "browser";
      readonly authentication: "browser";
      readonly credentialProvider: CredentialProvider<Fixture>;
    },
    ActorOptions<Fixture>
  >
>;
type BrowserWithoutCredentialIsForbidden = Assert<
  Not<
    IsAssignable<
      { readonly name: "browser"; readonly authentication: "browser" },
      ActorOptions<Fixture>
    >
  >
>;
type BearerWithCredentialIsAllowed = Assert<
  IsAssignable<
    {
      readonly name: "bearer";
      readonly authentication: "bearer";
      readonly credentialProvider: CredentialProvider<Fixture>;
    },
    ActorOptions<Fixture>
  >
>;
type BearerWithoutCredentialIsForbidden = Assert<
  Not<
    IsAssignable<
      { readonly name: "bearer"; readonly authentication: "bearer" },
      ActorOptions<Fixture>
    >
  >
>;

type BuildRequestCannotRepeatOperationMethod = Assert<
  Not<
    IsAssignable<
      {
        readonly id: "read";
        readonly method: "GET";
        readonly buildRequest: () => {
          readonly method: "DELETE";
          readonly path: "/resource";
        };
      },
      OperationOptions<Fixture>
    >
  >
>;

type CaseReportRejectsUnsupportedMethod = Assert<
  Not<
    IsAssignable<
      {
        readonly caseId: "case";
        readonly actorName: "actor";
        readonly operationId: "operation";
        readonly method: "CONNECT";
        readonly path: "/resource";
        readonly outcome: "passed";
        readonly expected: "expected";
        readonly actual: "actual";
        readonly failures: readonly [];
      },
      CaseReport
    >
  >
>;

describe(Actor.name, () => {
  it("represents anonymous actors without a credential capability", () => {
    const actor = new Actor<Fixture>({
      name: "anonymous",
      authentication: "anonymous",
    });

    expect(actor.authentication).toBe("anonymous");
    expect(actor.credentialProvider).toBeUndefined();
  });
});

export type ActorOptionsTypeAssertions =
  | AnonymousWithoutCredentialIsAllowed
  | AnonymousWithCredentialIsForbidden
  | BrowserWithCredentialIsAllowed
  | BrowserWithoutCredentialIsForbidden
  | BearerWithCredentialIsAllowed
  | BearerWithoutCredentialIsForbidden
  | BuildRequestCannotRepeatOperationMethod
  | CaseReportRejectsUnsupportedMethod;
