export type Session = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
};

export type SessionContext<Fixture> = { readonly fixture: Fixture };
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
