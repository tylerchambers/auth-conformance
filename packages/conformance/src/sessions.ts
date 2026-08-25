/** Supplies credentials merged into a case request immediately before sending. */
export type Session = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
};

/** Gives a session factory access to its case's isolated fixture. */
export type SessionContext<Fixture> = { readonly fixture: Fixture };
/**
 * Creates credentials for one case from that case's fixture.
 *
 * The runner invokes the factory once per case after fixture creation. Returned
 * header names override matching request headers case-insensitively; returned
 * cookies append to an existing Cookie header and values are URI-encoded.
 */
export type SessionFactory<Fixture> = (
  context: SessionContext<Fixture>,
) => Session | Promise<Session>;

type FactoryValue<Fixture, Value> =
  | Value
  | ((context: SessionContext<Fixture>) => Value | Promise<Value>);

function isFactoryValue<Fixture, Value>(
  value: FactoryValue<Fixture, Value>,
): value is (context: SessionContext<Fixture>) => Value | Promise<Value> {
  return typeof value === "function";
}

function resolveFactoryValue<Fixture, Value>(
  value: FactoryValue<Fixture, Value>,
  context: SessionContext<Fixture>,
): Value | Promise<Value> {
  return isFactoryValue(value) ? value(context) : value;
}

/** Creates a session factory that adds no credentials. */
function anonymous<Fixture>(): SessionFactory<Fixture> {
  return () => ({});
}

/** Creates a session factory that sets a Bearer Authorization header. */
function bearer<Fixture>(
  token: FactoryValue<Fixture, string>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: {
      Authorization: `Bearer ${await resolveFactoryValue(token, context)}`,
    },
  });
}

/** Creates a session factory that sets a configurable API-key header. */
function apiKey<Fixture>(
  headerName: string,
  key: FactoryValue<Fixture, string>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: { [headerName]: await resolveFactoryValue(key, context) },
  });
}

/** Creates a session factory that appends fixture-derived cookies. */
function cookies<Fixture>(
  value: FactoryValue<Fixture, Readonly<Record<string, string>>>,
): SessionFactory<Fixture> {
  return async (context) => ({
    cookies: await resolveFactoryValue(value, context),
  });
}

/** Creates a session factory from arbitrary fixture-derived headers. */
function fromHeaders<Fixture>(
  value: FactoryValue<Fixture, Readonly<Record<string, string>>>,
): SessionFactory<Fixture> {
  return async (context) => ({
    headers: await resolveFactoryValue(value, context),
  });
}

/**
 * Provides session factories for common HTTP authentication mechanisms.
 *
 * Factory inputs may be literals or callbacks evaluated against each case's
 * fresh fixture. Use `fromHeaders` when a protocol does not match a specialized
 * helper.
 */
export const sessions = Object.freeze({
  anonymous,
  bearer,
  apiKey,
  cookies,
  fromHeaders,
});
