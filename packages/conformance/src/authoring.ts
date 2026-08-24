import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";
import {
  type FixtureLifecycle,
  runAuthorizationCases,
} from "./authoring-execution.ts";
import {
  Actor,
  AuthorizationCase,
  AuthorizationCaseExpander,
  ExpectedResponse,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  Operation,
  type OperationRequest,
  type ResponseMismatch,
} from "./model.ts";
import type { HttpClient, SuiteReport } from "./runner.ts";

type Session = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
};

type SessionContext<Fixture> = { readonly fixture: Fixture };
type SessionFactory<Fixture> = (
  context: SessionContext<Fixture>,
) => Session | Promise<Session>;
type FactoryValue<Fixture, Value> =
  | Value
  | ((context: SessionContext<Fixture>) => Value | Promise<Value>);

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

type CaseAssertion<Fixture> = (input: {
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
  readonly fixture: Fixture;
}) => void | Promise<void>;

type OperationSelection =
  | { readonly ids: readonly string[]; readonly tags?: never }
  | { readonly tags: readonly string[]; readonly ids?: never };

type InventoryOperation = {
  readonly operationId: string;
  readonly method: AuthoringHttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
};

const operationInventoryBrand = Symbol("OperationInventory");
type OperationInventory = {
  readonly [operationInventoryBrand]: true;
  readonly operations: readonly InventoryOperation[];
};

type ErrorEnvelope = {
  readonly code: (body: unknown) => unknown;
};

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

const contractMetadata = Symbol("AuthorizationContractMetadata");
type BuiltAuthorizationContract<Fixture> =
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

function isFactoryValue<Fixture, Value>(
  value: FactoryValue<Fixture, Value>,
): value is (context: SessionContext<Fixture>) => Value | Promise<Value> {
  return typeof value === "function";
}

async function resolveFactoryValue<Fixture, Value>(
  value: FactoryValue<Fixture, Value>,
  context: SessionContext<Fixture>,
): Promise<Value> {
  return isFactoryValue(value) ? await value(context) : value;
}

function anonymous<Fixture>(): SessionFactory<Fixture> {
  return () => ({});
}

function bearer<Fixture>(
  token: FactoryValue<Fixture, string>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: {
      Authorization: `Bearer ${await resolveFactoryValue(token, context)}`,
    },
  });
}

function apiKey<Fixture>(
  headerName: string,
  key: FactoryValue<Fixture, string>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: { [headerName]: await resolveFactoryValue(key, context) },
  });
}

function cookies<Fixture>(
  value: FactoryValue<Fixture, Readonly<Record<string, string>>>,
): SessionFactory<Fixture> {
  return async (context) => ({
    cookies: await resolveFactoryValue(value, context),
  });
}

function fromHeaders<Fixture>(
  value: FactoryValue<Fixture, Readonly<Record<string, string>>>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: await resolveFactoryValue(value, context),
  });
}

export const sessions = Object.freeze({
  anonymous,
  bearer,
  apiKey,
  cookies,
  fromHeaders,
});

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

function strictBodyExpectation(value: unknown): ExpectedResponse {
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

function containingBodyExpectation(subset: unknown): ExpectedResponse {
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

function noContentExpectation(): ExpectedResponse {
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

function errorExpectation(
  envelope: ErrorEnvelope,
  status: number,
  code: string | undefined,
): ExpectedResponse {
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

function callbackExpectation<Fixture>(
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

const supportedMethods = [
  "delete",
  "get",
  "head",
  "patch",
  "post",
  "put",
] as const;

const authoringMethodByOpenApiMethod: Record<
  (typeof supportedMethods)[number],
  AuthoringHttpMethod
> = {
  delete: "DELETE",
  get: "GET",
  head: "HEAD",
  patch: "PATCH",
  post: "POST",
  put: "PUT",
};

export function fromOpenApi(documentOrUrl: unknown): OperationInventory {
  const document = readOpenApiDocument(documentOrUrl);
  if (!isPlainRecord(document.paths)) {
    throw new Error("OpenAPI document must contain a paths object");
  }

  const operations: InventoryOperation[] = [];
  const operationIds = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isPlainRecord(pathItem)) {
      continue;
    }
    for (const method of supportedMethods) {
      const candidate = pathItem[method];
      if (candidate === undefined) {
        continue;
      }
      if (
        !isPlainRecord(candidate) ||
        typeof candidate.operationId !== "string"
      ) {
        throw new Error(
          `OpenAPI operation ${method.toUpperCase()} ${path} must have an operationId`,
        );
      }
      if (operationIds.has(candidate.operationId)) {
        throw new Error(
          `Duplicate OpenAPI operation ID "${candidate.operationId}"`,
        );
      }
      operationIds.add(candidate.operationId);
      operations.push({
        operationId: candidate.operationId,
        method: authoringMethodByOpenApiMethod[method],
        path,
        tags: readTags(candidate.tags, candidate.operationId),
      });
    }
  }

  return Object.freeze({
    [operationInventoryBrand]: true,
    operations: Object.freeze(operations),
  });
}

function readOpenApiDocument(documentOrUrl: unknown): Record<string, unknown> {
  if (isPlainRecord(documentOrUrl)) {
    return documentOrUrl;
  }
  if (typeof documentOrUrl !== "string" && !(documentOrUrl instanceof URL)) {
    throw new TypeError(
      "fromOpenApi expects an OpenAPI document or local file URL",
    );
  }

  const path = openApiFilePath(documentOrUrl);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainRecord(parsed)) {
    throw new Error(`OpenAPI file "${path}" must contain a JSON object`);
  }
  return parsed;
}

function openApiFilePath(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new Error(
        `fromOpenApi cannot synchronously load ${value.protocol} URLs; pass the parsed document instead`,
      );
    }
    return fileURLToPath(value);
  }
  if (/^https?:\/\//i.test(value)) {
    throw new Error(
      "fromOpenApi cannot synchronously load HTTP URLs; pass the parsed document instead",
    );
  }
  return value;
}

function readTags(value: unknown, operationId: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw new Error(`OpenAPI operation "${operationId}" has invalid tags`);
  }
  return Object.freeze([...value]);
}

class FetchHttpClient implements HttpClient {
  constructor(private readonly baseUrl: () => string | URL) {}

  async execute(
    request: HttpRequest,
    signal: AbortSignal,
  ): Promise<HttpResponse> {
    const headers = new Headers(request.headers);
    const body = requestBody(request, headers);
    const requestInit: RequestInit = {
      method: request.method,
      headers,
      signal,
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const response = await fetch(
      new URL(request.path, this.baseUrl()),
      requestInit,
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody(text, response.headers.get("content-type")),
    };
  }
}

function requestBody(
  request: HttpRequest,
  headers: Headers,
): BodyInit | undefined {
  if (request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === "string") {
    return request.body;
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(request.body);
}

function responseBody(text: string, contentType: string | null): unknown {
  if (text === "") {
    return undefined;
  }
  if (contentType?.toLowerCase().includes("json") !== true) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runAuthorizationTests<Fixture>(
  contract: BuiltAuthorizationContract<Fixture>,
): Promise<SuiteReport> {
  const metadata = contract[contractMetadata];
  if (metadata === undefined) {
    throw new TypeError(
      "runAuthorizationTests expects the result of authorizationContract(...).build()",
    );
  }
  return runAuthorizationCases({
    suiteId: metadata.name,
    cases: contract,
    lifecycle: metadata.lifecycle,
    httpClient: new FetchHttpClient(metadata.baseUrl),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
