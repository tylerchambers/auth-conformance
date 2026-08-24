import {
  type CaseAssertion,
  callbackExpectation,
  containingBodyExpectation,
  type ErrorEnvelope,
  errorExpectation,
  noContentExpectation,
  strictBodyExpectation,
} from "./authoring-expectations.ts";
import {
  Actor,
  AuthorizationCase,
  AuthorizationCaseExpander,
  ExpectedResponse,
  type HttpMethod,
  type HttpRequest,
  Operation,
  type OperationRequest,
} from "./model.ts";
import type {
  InventoryOperation,
  OperationInventory,
} from "./openapi-inventory.ts";
import type { FixtureLifecycle } from "./runner.ts";
import type { Session, SessionContext, SessionFactory } from "./sessions.ts";

type FixtureValue<Fixture> =
  | string
  | number
  | ((context: SessionContext<Fixture>) => string | number);

type SegmentParam<Segment extends string> = Segment extends `:${infer Name}`
  ? Name
  : never;
type PathParams<Path extends string> =
  Path extends `${infer Segment}/${infer Rest}`
    ? SegmentParam<Segment> | PathParams<Rest>
    : SegmentParam<Path>;

type RequestBase = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

type RequestForPath<Fixture, Path extends string> = [PathParams<Path>] extends [
  never,
]
  ? RequestBase & { readonly params?: never }
  : RequestBase & {
      readonly params: {
        readonly [Name in PathParams<Path>]: FixtureValue<Fixture>;
      };
    };

type RequestArguments<Fixture, Path extends string> = [
  PathParams<Path>,
] extends [never]
  ? [request?: RequestForPath<Fixture, Path>]
  : [request: RequestForPath<Fixture, Path>];

type OperationSelection =
  | { readonly ids: readonly string[]; readonly tags?: never }
  | { readonly tags: readonly string[]; readonly ids?: never };

type AuthorizationContractOptions<Fixture> = {
  readonly name: string;
  readonly baseUrl: () => string | URL;
  readonly error: ErrorEnvelope;
  readonly lifecycle: FixtureLifecycle<Fixture>;
  readonly operations?: OperationInventory;
};

type CaseActorBuilder<Fixture, ActorName extends string> = {
  id(id: string): CaseActorBuilder<Fixture, ActorName>;
  as(actorName: ActorName): CaseOperationBuilder<Fixture, ActorName>;
};

type CaseOperationBuilder<Fixture, ActorName extends string> = {
  id(id: string): CaseOperationBuilder<Fixture, ActorName>;
  get<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
  post<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
  put<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
  patch<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
  delete<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
  head<const Path extends string>(
    path: Path,
    ...request: RequestArguments<Fixture, NoInfer<Path>>
  ): CaseExpectationBuilder<Fixture, ActorName>;
};

type ExpectationTerminals<Fixture, Result> = {
  expectStatus(status: number): Result;
  expectBody(value: unknown): Result;
  expectBodyContaining(subset: unknown): Result;
  expectNoContent(): Result;
  expectError(status: number, code?: string): Result;
  expectThat(assertion: CaseAssertion<Fixture>): Result;
};

type CaseExpectationBuilder<Fixture, ActorName extends string> = {
  id(id: string): CaseExpectationBuilder<Fixture, ActorName>;
} & ExpectationTerminals<Fixture, AuthorizationContract<Fixture, ActorName>>;

type RuleSelectionBuilder<Fixture, ActorName extends string> = {
  forAllOperations(): RuleActorBuilder<Fixture, ActorName>;
  forOperations(
    selection: OperationSelection,
  ): RuleActorBuilder<Fixture, ActorName>;
};

type RuleActorBuilder<Fixture, ActorName extends string> = {
  as(actorName: ActorName): RuleExpectationBuilder<Fixture, ActorName>;
};

type RuleExpectationBuilder<
  Fixture,
  ActorName extends string,
> = ExpectationTerminals<Fixture, AuthorizationContract<Fixture, ActorName>>;

type AuthorizationContract<Fixture, ActorName extends string> = {
  actor<Name extends string>(
    name: Name,
    factory: SessionFactory<Fixture>,
  ): AuthorizationContract<Fixture, ActorName | Name>;
  case(description: string): CaseActorBuilder<Fixture, ActorName>;
  rule(description: string): RuleSelectionBuilder<Fixture, ActorName>;
  build(): BuiltAuthorizationContract<Fixture>;
};

type ContractMetadata<Fixture> = {
  readonly name: string;
  readonly baseUrl: () => string | URL;
  readonly lifecycle: FixtureLifecycle<Fixture>;
};

export const contractMetadata = Symbol("AuthorizationContractMetadata");
export type BuiltAuthorizationContract<Fixture> =
  readonly AuthorizationCase<Fixture>[] & {
    readonly [contractMetadata]: ContractMetadata<Fixture>;
  };

type AuthoringHttpMethod = Extract<
  HttpMethod,
  "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT"
>;

type DeclarationDraft = {
  readonly kind: "case" | "rule";
  readonly description: string;
  complete: boolean;
};

type ContractState<Fixture> = {
  readonly options: AuthorizationContractOptions<Fixture>;
  readonly actors: Map<string, Actor<Fixture>>;
  readonly declarations: DeclarationDraft[];
  readonly invariants: Array<{
    readonly id: string;
    expand(): readonly AuthorizationCase<Fixture>[];
  }>;
};

type CaseDraft<Fixture> = DeclarationDraft & {
  readonly kind: "case";
  explicitId?: string;
  actor?: Actor<Fixture>;
  operation?: Operation<Fixture>;
};

type RuleDraft<Fixture> = DeclarationDraft & {
  readonly kind: "rule";
  operations?: readonly InventoryOperation[];
  actor?: Actor<Fixture>;
};

export function authorizationContract<Fixture>(
  options: AuthorizationContractOptions<Fixture>,
): AuthorizationContract<Fixture, never> {
  return makeContract({
    options,
    actors: new Map(),
    declarations: [],
    invariants: [],
  });
}

function makeContract<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
): AuthorizationContract<Fixture, ActorName> {
  return {
    actor<Name extends string>(name: Name, factory: SessionFactory<Fixture>) {
      if (state.actors.has(name)) {
        throw new Error(`Actor "${name}" is already registered`);
      }
      state.actors.set(name, buildActor(name, factory));
      return makeContract<Fixture, ActorName | Name>(state);
    },
    case(description) {
      const draft: CaseDraft<Fixture> = {
        kind: "case",
        description,
        complete: false,
      };
      state.declarations.push(draft);
      return makeCaseActorBuilder<Fixture, ActorName>(state, draft);
    },
    rule(description) {
      const draft: RuleDraft<Fixture> = {
        kind: "rule",
        description,
        complete: false,
      };
      state.declarations.push(draft);
      return makeRuleSelectionBuilder<Fixture, ActorName>(state, draft);
    },
    build() {
      const incomplete = state.declarations.find(
        (declaration) => !declaration.complete,
      );
      if (incomplete !== undefined) {
        throw new Error(
          `Authorization ${incomplete.kind} "${incomplete.description}" requires exactly one expectation`,
        );
      }
      const cases = new AuthorizationCaseExpander().expand(state.invariants);
      return Object.freeze(
        Object.assign([...cases], {
          [contractMetadata]: {
            name: state.options.name,
            baseUrl: state.options.baseUrl,
            lifecycle: state.options.lifecycle,
          },
        }),
      );
    },
  };
}

function buildActor<Fixture>(
  name: string,
  factory: SessionFactory<Fixture>,
): Actor<Fixture> {
  return new Actor({
    name,
    authentication: "integration",
    credentialProvider: {
      async authorize({ fixture, request }) {
        return applySession(request, await factory({ fixture }));
      },
    },
  });
}

function applySession(request: HttpRequest, session: Session): HttpRequest {
  const headers: Record<string, string> = { ...request.headers };
  for (const [name, value] of Object.entries(session.headers ?? {})) {
    setHeader(headers, name, value);
  }
  if (session.cookies !== undefined) {
    const cookie = Object.entries(session.cookies)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    if (cookie !== "") {
      const existing = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "cookie",
      );
      setHeader(
        headers,
        "Cookie",
        existing === undefined ? cookie : `${existing[1]}; ${cookie}`,
      );
    }
  }

  return mergedHeadersRequest(request, headers);
}

function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const existingName = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (existingName !== undefined) {
    delete headers[existingName];
  }
  headers[name] = value;
}

function mergedHeadersRequest(
  request: HttpRequest,
  headers: Readonly<Record<string, string>>,
): HttpRequest {
  if (Object.keys(headers).length === 0) {
    return request;
  }
  return { ...request, headers };
}

function makeCaseActorBuilder<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  draft: CaseDraft<Fixture>,
): CaseActorBuilder<Fixture, ActorName> {
  return {
    id(id) {
      setExplicitId(draft, id);
      return this;
    },
    as(actorName) {
      assertIncomplete(draft);
      draft.actor = findActor(state, actorName);
      return makeCaseOperationBuilder<Fixture, ActorName>(state, draft);
    },
  };
}

function makeCaseOperationBuilder<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  draft: CaseDraft<Fixture>,
): CaseOperationBuilder<Fixture, ActorName> {
  const declare = <Path extends string>(
    method: AuthoringHttpMethod,
    path: Path,
    request: RequestForPath<Fixture, Path> | undefined,
  ): CaseExpectationBuilder<Fixture, ActorName> => {
    assertIncomplete(draft);
    draft.operation = new Operation({
      id: operationDiscriminator(method, path),
      method,
      catalogPath: path,
      buildRequest: (fixture) => buildOperationRequest(path, request, fixture),
    });
    return makeCaseExpectationBuilder<Fixture, ActorName>(state, draft);
  };

  return {
    id(id) {
      setExplicitId(draft, id);
      return this;
    },
    get(path, ...request) {
      return declare("GET", path, request[0]);
    },
    post(path, ...request) {
      return declare("POST", path, request[0]);
    },
    put(path, ...request) {
      return declare("PUT", path, request[0]);
    },
    patch(path, ...request) {
      return declare("PATCH", path, request[0]);
    },
    delete(path, ...request) {
      return declare("DELETE", path, request[0]);
    },
    head(path, ...request) {
      return declare("HEAD", path, request[0]);
    },
  };
}

function buildOperationRequest<Fixture, Path extends string>(
  path: Path,
  request: RequestForPath<Fixture, Path> | undefined,
  fixture: Fixture,
): OperationRequest {
  const resolvedPath = resolvePath(path, request?.params, fixture);
  const result: {
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: unknown;
  } = { path: resolvedPath };
  if (request?.headers !== undefined) {
    result.headers = request.headers;
  }
  if (request !== undefined && "body" in request) {
    result.body = request.body;
  }
  return result;
}

function resolvePath<Fixture>(
  path: string,
  params: Readonly<Record<string, FixtureValue<Fixture>>> | undefined,
  fixture: Fixture,
): string {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const expectedNames = new Set(names);
  const suppliedNames = Object.keys(params ?? {});
  for (const name of expectedNames) {
    if (params === undefined || !(name in params)) {
      throw new Error(`Missing path parameter "${name}" for "${path}"`);
    }
  }
  for (const name of suppliedNames) {
    if (!expectedNames.has(name)) {
      throw new Error(`Unused path parameter "${name}" for "${path}"`);
    }
  }

  return path.replace(/:([A-Za-z0-9_]+)/g, (_placeholder, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for "${path}"`);
    }
    const resolved = typeof value === "function" ? value({ fixture }) : value;
    return encodeURIComponent(String(resolved));
  });
}

function makeCaseExpectationBuilder<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  draft: CaseDraft<Fixture>,
): CaseExpectationBuilder<Fixture, ActorName> {
  return {
    id(id) {
      setExplicitId(draft, id);
      return this;
    },
    ...expectationTerminals(state, (expectedResponse) => {
      assertIncomplete(draft);
      if (draft.actor === undefined || draft.operation === undefined) {
        throw new Error("A case requires one actor and one operation");
      }
      draft.complete = true;
      const authorizationCase = new AuthorizationCase({
        id:
          draft.explicitId ??
          generatedCaseId(
            draft.description,
            draft.operation.id,
            draft.actor.name,
          ),
        actor: draft.actor,
        operation: draft.operation,
        expectedResponse,
      });
      state.invariants.push({
        id: authorizationCase.id,
        expand: () => [authorizationCase],
      });
    }),
  };
}

function expectationTerminals<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  complete: (expectedResponse: ExpectedResponse) => void,
): ExpectationTerminals<Fixture, AuthorizationContract<Fixture, ActorName>> {
  const finish = (expectedResponse: ExpectedResponse) => {
    complete(expectedResponse);
    return makeContract<Fixture, ActorName>(state);
  };

  return {
    expectStatus(status) {
      return finish(ExpectedResponse.status(status));
    },
    expectBody(value) {
      return finish(strictBodyExpectation(value));
    },
    expectBodyContaining(subset) {
      return finish(containingBodyExpectation(subset));
    },
    expectNoContent() {
      return finish(noContentExpectation());
    },
    expectError(status, code) {
      return finish(errorExpectation(state.options.error, status, code));
    },
    expectThat(assertion) {
      return finish(callbackExpectation(assertion));
    },
  };
}

function setExplicitId<Fixture>(draft: CaseDraft<Fixture>, id: string): void {
  assertIncomplete(draft);
  if (draft.explicitId !== undefined) {
    throw new Error("A case ID may only be set once");
  }
  if (id.trim() === "") {
    throw new Error("A case ID must not be empty");
  }
  draft.explicitId = id;
}

function assertIncomplete(draft: { readonly complete: boolean }): void {
  if (draft.complete) {
    throw new Error(
      "An authorization declaration accepts exactly one expectation",
    );
  }
}

function makeRuleSelectionBuilder<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  draft: RuleDraft<Fixture>,
): RuleSelectionBuilder<Fixture, ActorName> {
  return {
    forAllOperations() {
      draft.operations = requireInventory(state).operations;
      return makeRuleActorBuilder<Fixture, ActorName>(state, draft);
    },
    forOperations(selection) {
      const inventory = requireInventory(state);
      draft.operations = selectOperations(inventory, selection);
      return makeRuleActorBuilder<Fixture, ActorName>(state, draft);
    },
  };
}

function makeRuleActorBuilder<Fixture, ActorName extends string>(
  state: ContractState<Fixture>,
  draft: RuleDraft<Fixture>,
): RuleActorBuilder<Fixture, ActorName> {
  return {
    as(actorName) {
      assertIncomplete(draft);
      draft.actor = findActor(state, actorName);
      return expectationTerminals(state, (expectedResponse) => {
        assertIncomplete(draft);
        if (draft.actor === undefined || draft.operations === undefined) {
          throw new Error("A rule requires an operation selection and actor");
        }
        draft.complete = true;
        const actor = draft.actor;
        const operations = draft.operations;
        state.invariants.push({
          id: slug(draft.description),
          expand: () =>
            operations.map((inventoryOperation) => {
              const operation =
                inventoryOperationModel<Fixture>(inventoryOperation);
              return new AuthorizationCase({
                id: generatedCaseId(
                  draft.description,
                  inventoryOperation.operationId,
                  actor.name,
                ),
                actor,
                operation,
                expectedResponse,
              });
            }),
        });
      });
    },
  };
}

function requireInventory<Fixture>(
  state: ContractState<Fixture>,
): OperationInventory {
  const inventory = state.options.operations;
  if (inventory === undefined) {
    throw new Error("An authorization rule requires an operation inventory");
  }
  return inventory;
}

function selectOperations(
  inventory: OperationInventory,
  selection: OperationSelection,
): readonly InventoryOperation[] {
  if (selection.ids !== undefined) {
    const byId = new Map(
      inventory.operations.map((operation) => [
        operation.operationId,
        operation,
      ]),
    );
    for (const id of selection.ids) {
      if (!byId.has(id)) {
        throw new Error(`Unknown operation ID "${id}"`);
      }
    }
    return uniqueOperations(selection.ids.map((id) => byId.get(id)));
  }

  const knownTags = new Set(
    inventory.operations.flatMap((operation) => operation.tags),
  );
  for (const tag of selection.tags) {
    if (!knownTags.has(tag)) {
      throw new Error(`Unknown operation tag "${tag}"`);
    }
  }
  const selectedTags = new Set(selection.tags);
  return inventory.operations.filter((operation) =>
    operation.tags.some((tag) => selectedTags.has(tag)),
  );
}

function uniqueOperations(
  operations: readonly (InventoryOperation | undefined)[],
): readonly InventoryOperation[] {
  const unique = new Map<string, InventoryOperation>();
  for (const operation of operations) {
    if (operation !== undefined) {
      unique.set(operation.operationId, operation);
    }
  }
  return [...unique.values()];
}

function inventoryOperationModel<Fixture>(
  inventoryOperation: InventoryOperation,
): Operation<Fixture> {
  return new Operation({
    id: inventoryOperation.operationId,
    method: inventoryOperation.method,
    catalogPath: inventoryOperation.path,
    buildRequest: () => ({ path: inventoryOperation.path }),
  });
}

function findActor<Fixture>(
  state: ContractState<Fixture>,
  actorName: string,
): Actor<Fixture> {
  const actor = state.actors.get(actorName);
  if (actor === undefined) {
    throw new Error(`Unknown actor "${actorName}"`);
  }
  return actor;
}

function generatedCaseId(
  description: string,
  operationId: string,
  actorName: string,
): string {
  return `${slug(description)}/${operationId}/${actorName}`;
}

function operationDiscriminator(
  method: AuthoringHttpMethod,
  path: string,
): string {
  return `${method.toLowerCase()}-${slug(path)}`;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "case" : normalized;
}
