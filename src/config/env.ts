export class ConfigError extends Error {
  override name = "ConfigError";
}

type Default<T> = { default?: T };

export type EnvReader = {
  string(name: string, options?: Default<string>): string;
  optionalString(name: string): string | undefined;
  int(name: string, options?: Default<number>): number;
  bool(name: string, options?: Default<boolean>): boolean;
  duration(name: string, options?: Default<string>): number;
  list(name: string, options?: Default<string[]>): string[];
  enumOf<T extends string>(name: string, values: readonly T[], fallback?: T): T;
  custom<T>(
    name: string,
    accepted: string,
    parse: (raw: string) => T | undefined,
    fallback?: T,
  ): T;
  scope(prefix: string): EnvReader;
  assertValid(): void;
};

export function envId(id: string): string {
  return id.toUpperCase().replaceAll("-", "_");
}

const durationPattern = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/;

export function parseDuration(raw: string): number | undefined {
  const match = durationPattern.exec(raw);
  if (!match || raw === "") return undefined;
  const [, h = "0", m = "0", s = "0", ms = "0"] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

const parseInt = (raw: string) =>
  /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;

const booleans = new Map([
  ["true", true],
  ["false", false],
]);
const parseBool = (raw: string) => booleans.get(raw.toLowerCase());

export const parseList = (raw: string) =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

export function createEnvReader(
  vars: Record<string, string | undefined>,
): EnvReader {
  return scopedReader(vars, "", []);
}

function rawReader(vars: Record<string, string | undefined>, prefix: string) {
  return (name: string) => {
    const value = vars[prefix + name]?.trim();
    return value === "" ? undefined : value;
  };
}

function customReader(
  raw: (name: string) => string | undefined,
  prefix: string,
  problems: string[],
) {
  return <T>(
    name: string,
    accepted: string,
    parse: (raw: string) => T | undefined,
    fallback?: T,
  ): T => {
    const value = raw(name);
    const parsed = value === undefined ? fallback : parse(value);
    if (parsed !== undefined) return parsed;
    problems.push(
      `${prefix + name}: ${value === undefined ? "required" : `"${value}" is not valid`}; accepted: ${accepted}`,
    );
    return undefined as T;
  };
}

function scopedReader(
  vars: Record<string, string | undefined>,
  prefix: string,
  problems: string[],
): EnvReader {
  const raw = rawReader(vars, prefix);
  const custom = customReader(raw, prefix, problems);
  return {
    custom,
    string: (name, o = {}) => custom(name, "any text", (v) => v, o.default),
    optionalString: raw,
    int: (name, o = {}) =>
      custom(name, "a positive integer", parseInt, o.default),
    bool: (name, o = {}) => custom(name, "true, false", parseBool, o.default),
    duration: (name, o = {}) =>
      custom(
        name,
        "a duration such as 750ms, 2s, 5m, 12h35m",
        parseDuration,
        o.default === undefined ? undefined : parseDuration(o.default),
      ),
    list: (name, o = {}) =>
      custom(name, "a comma separated list", parseList, o.default),
    enumOf: (name, values, fallback) =>
      custom(
        name,
        values.join(", "),
        (v) => values.find((value) => value === v),
        fallback,
      ),
    scope: (inner) => scopedReader(vars, prefix + inner, problems),
    assertValid: () => {
      if (problems.length === 0) return;
      throw new ConfigError(
        `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      );
    },
  };
}
