import { compareStableText } from "./ordering.ts";

export type AuthenticationKind =
  | "anonymous"
  | "browser"
  | "bearer"
  | "integration";
export type HttpMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT"
  | "TRACE";

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

export type OperationRequest = Omit<HttpRequest, "method"> & {
  readonly method?: never;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

export type CredentialRequestContext<TFixture> = {
  readonly fixture: TFixture;
  readonly request: HttpRequest;
  readonly signal: AbortSignal;
};

/** Applies an actor's credential without exposing it to framework reports. */
export interface CredentialProvider<TFixture> {
  authorize(
    context: CredentialRequestContext<TFixture>,
  ): Promise<HttpRequest> | HttpRequest;
}

type ActorCommonOptions = {
  readonly name: string;
  readonly securityProperties?: Readonly<Record<string, string | boolean>>;
};

export type ActorOptions<TFixture> = ActorCommonOptions &
  (
    | {
        readonly authentication: "anonymous";
        readonly credentialProvider?: never;
      }
    | {
        readonly authentication: "browser" | "bearer" | "integration";
        readonly credentialProvider: CredentialProvider<TFixture>;
      }
  );

/** A named principal capability used by declarative authorization cases. */
export class Actor<TFixture> {
  readonly name: string;
  readonly authentication: AuthenticationKind;
  readonly credentialProvider: CredentialProvider<TFixture> | undefined;
  readonly securityProperties: Readonly<Record<string, string | boolean>>;

  constructor(options: ActorOptions<TFixture>) {
    this.name = options.name;
    this.authentication = options.authentication;
    this.credentialProvider =
      options.authentication === "anonymous"
        ? undefined
        : options.credentialProvider;
    this.securityProperties = options.securityProperties ?? {};
  }
}

export type OperationOptions<TFixture> = {
  readonly id: string;
  readonly method: HttpMethod;
  readonly catalogPath?: string;
  readonly buildRequest: (fixture: TFixture) => OperationRequest;
};

export type ResourceReferenceOptions<TFixture, TValue> = {
  readonly id: string;
  readonly resolve: (fixture: TFixture) => TValue;
};

/** A stable named reference resolved against each isolated fixture context. */
export class ResourceReference<TFixture, TValue> {
  readonly id: string;
  private readonly resolveFromFixture: (fixture: TFixture) => TValue;

  constructor(options: ResourceReferenceOptions<TFixture, TValue>) {
    this.id = options.id;
    this.resolveFromFixture = options.resolve;
  }

  resolve(fixture: TFixture): TValue {
    return this.resolveFromFixture(fixture);
  }
}

/** Builds one public HTTP operation from the current fixture context. */
export class Operation<TFixture> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly catalogPath: string | undefined;
  private readonly buildRequestFromFixture: (
    fixture: TFixture,
  ) => OperationRequest;

  constructor(options: OperationOptions<TFixture>) {
    this.id = options.id;
    this.method = options.method;
    this.catalogPath = options.catalogPath;
    this.buildRequestFromFixture = options.buildRequest;
  }

  buildRequest(fixture: TFixture): HttpRequest {
    return { ...this.buildRequestFromFixture(fixture), method: this.method };
  }
}

export type ResponseMismatchKind = "policy" | "malformed-response";

export type ResponseMismatch = {
  readonly kind: ResponseMismatchKind;
  readonly message: string;
};

export type ExpectedResponseOptions = {
  readonly description: string;
  readonly evaluate: (
    response: HttpResponse,
    fixture?: unknown,
  ) => readonly ResponseMismatch[] | Promise<readonly ResponseMismatch[]>;
};

/** Describes safe observable response expectations without retaining credentials. */
export class ExpectedResponse {
  readonly description: string;
  private readonly evaluateResponse: (
    response: HttpResponse,
    fixture?: unknown,
  ) => readonly ResponseMismatch[] | Promise<readonly ResponseMismatch[]>;

  constructor(options: ExpectedResponseOptions) {
    this.description = options.description;
    this.evaluateResponse = options.evaluate;
  }

  static status(status: number): ExpectedResponse {
    return new ExpectedResponse({
      description: `HTTP ${status}`,
      evaluate: (response) =>
        response.status === status
          ? []
          : [
              {
                kind: "policy",
                message: `expected HTTP ${status}, received HTTP ${response.status}`,
              },
            ],
    });
  }

  evaluate(
    response: HttpResponse,
    fixture?: unknown,
  ): readonly ResponseMismatch[] | Promise<readonly ResponseMismatch[]> {
    return this.evaluateResponse(response, fixture);
  }
}

export type ApiPostconditionContext<TFixture> = {
  readonly fixture: TFixture;
  readonly execute: (
    actor: Actor<TFixture>,
    operation: Operation<TFixture>,
    signal: AbortSignal,
  ) => Promise<HttpResponse>;
  readonly signal: AbortSignal;
};

/** Verifies resulting state exclusively through public HTTP operations. */
export interface ApiPostcondition<TFixture> {
  readonly description: string;
  verify(
    context: ApiPostconditionContext<TFixture>,
  ): Promise<readonly ResponseMismatch[]>;
}

export type AuthorizationCaseOptions<TFixture> = {
  readonly id: string;
  readonly actor: Actor<TFixture>;
  readonly operation: Operation<TFixture>;
  readonly expectedResponse: ExpectedResponse;
  readonly postconditions?: readonly ApiPostcondition<TFixture>[];
  readonly tags?: readonly string[];
};

/** One named actor/action/expectation/postcondition scenario. */
export class AuthorizationCase<TFixture> {
  readonly id: string;
  readonly actor: Actor<TFixture>;
  readonly operation: Operation<TFixture>;
  readonly expectedResponse: ExpectedResponse;
  readonly postconditions: readonly ApiPostcondition<TFixture>[];
  readonly tags: readonly string[];

  constructor(options: AuthorizationCaseOptions<TFixture>) {
    this.id = options.id;
    this.actor = options.actor;
    this.operation = options.operation;
    this.expectedResponse = options.expectedResponse;
    this.postconditions = Object.freeze([...(options.postconditions ?? [])]);
    this.tags = Object.freeze([...(options.tags ?? [])]);
  }
}

export interface AuthorizationInvariant<TFixture> {
  readonly id: string;
  expand(): readonly AuthorizationCase<TFixture>[];
}

export class DuplicateAuthorizationCaseIdError extends Error {
  constructor(readonly caseId: string) {
    super(`Duplicate authorization case ID: ${caseId}`);
    this.name = DuplicateAuthorizationCaseIdError.name;
  }
}

/** Expands invariant factories into immutable, deterministic case-ID order. */
export class AuthorizationCaseExpander {
  expand<TFixture>(
    invariants: readonly AuthorizationInvariant<TFixture>[],
  ): readonly AuthorizationCase<TFixture>[] {
    const byId = new Map<string, AuthorizationCase<TFixture>>();
    for (const invariant of invariants) {
      for (const authorizationCase of invariant.expand()) {
        if (byId.has(authorizationCase.id)) {
          throw new DuplicateAuthorizationCaseIdError(authorizationCase.id);
        }
        byId.set(authorizationCase.id, authorizationCase);
      }
    }

    return Object.freeze(
      [...byId.values()].sort((left, right) =>
        compareStableText(left.id, right.id),
      ),
    );
  }
}
