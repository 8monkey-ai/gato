export type EnvSource = Record<string, string | undefined>;

export class ConfigError extends Error {}

function fail(name: string, value: string, expected: string): never {
  throw new ConfigError(`Invalid ${name}="${value}". ${expected}`);
}

const durationUnits: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
};

export function parseDuration(name: string, value: string) {
  const parts = [...value.matchAll(/(\d+)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== value) {
    fail(name, value, 'Use a duration such as "750ms", "30s" or "12h35m".');
  }
  return parts.reduce(
    (sum, [, amount, unit]) => sum + Number(amount) * durationUnits[unit!]!,
    0,
  );
}

function required(name: string, value: string | undefined, hint: string) {
  if (value === undefined) throw new ConfigError(`Missing ${name}. ${hint}`);
  return value;
}

function choice<T extends string>(
  name: string,
  value: string,
  options: readonly T[],
) {
  if (!options.includes(value as T)) {
    fail(name, value, `Use one of: ${options.join(", ")}.`);
  }
  return value as T;
}

function wholeNumber(name: string, value: string) {
  if (!/^\d+$/.test(value)) fail(name, value, "Use a whole number.");
  return Number(value);
}

function boolean(name: string, value: string) {
  if (value !== "true" && value !== "false") {
    fail(name, value, 'Use "true" or "false".');
  }
  return value === "true";
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export type Env = ReturnType<typeof readEnv>;

export function readEnv(source: EnvSource, prefix = "") {
  const name = (key: string) => prefix + key;
  const raw = (key: string) => {
    const value = source[name(key)]?.trim();
    return value === "" ? undefined : value;
  };
  return {
    name,
    optional: raw,
    string: (key: string, fallback?: string) =>
      required(name(key), raw(key) ?? fallback, "Set it in the environment."),
    oneOf: <T extends string>(
      key: string,
      options: readonly T[],
      fallback?: T,
    ) =>
      choice(
        name(key),
        required(
          name(key),
          raw(key) ?? fallback,
          `Use one of: ${options.join(", ")}.`,
        ),
        options,
      ),
    int: (key: string, fallback: number) => {
      const value = raw(key);
      return value === undefined ? fallback : wholeNumber(name(key), value);
    },
    bool: (key: string, fallback: boolean) => {
      const value = raw(key);
      return value === undefined ? fallback : boolean(name(key), value);
    },
    duration: (key: string, fallback: string) =>
      parseDuration(name(key), raw(key) ?? fallback),
    list: (key: string, fallback: string[] = []) => {
      const value = raw(key);
      return value === undefined ? fallback : splitList(value);
    },
    scoped: (scope: string) => readEnv(source, prefix + scope),
  };
}
