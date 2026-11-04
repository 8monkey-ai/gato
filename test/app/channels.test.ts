import { expect, test } from "bun:test";

import { createAdapters } from "../../src/app/channels.ts";
import { createLogger } from "../../src/log/logger.ts";
import { fakeRegistration } from "../support/fake-adapter.ts";

const logger = createLogger({ GATO_LOG_LEVEL: "silent" });
const alpha = fakeRegistration("alpha", "GATO_ALPHA_CONNECTIONS");
const beta = fakeRegistration("beta", "GATO_BETA_CONNECTIONS");

test("creates one adapter for each connection of each enabled kind", () => {
  const adapters = createAdapters(
    [alpha, beta],
    {
      GATO_ALPHA_CONNECTIONS: '{"main":{"token":"a"},"backup":{"token":"b"}}',
      GATO_BETA_CONNECTIONS: '{"sales":{"token":"c"}}',
    },
    logger,
  );
  expect(
    adapters.map((adapter) => `${adapter.kind}/${adapter.connection}`),
  ).toEqual(["alpha/main", "alpha/backup", "beta/sales"]);
});

test("a kind without its variable is disabled and needs no settings", () => {
  expect(
    createAdapters([alpha, beta], { GATO_ALPHA_CONNECTIONS: "" }, logger),
  ).toEqual([]);
});

test("names the variable and the path of a setting that is not valid", () => {
  expect(() =>
    createAdapters([alpha], { GATO_ALPHA_CONNECTIONS: '{"main":{}}' }, logger),
  ).toThrow(new Error("GATO_ALPHA_CONNECTIONS.main.token: Required"));
  expect(() =>
    createAdapters([alpha], { GATO_ALPHA_CONNECTIONS: "{main" }, logger),
  ).toThrow(new Error("GATO_ALPHA_CONNECTIONS: expected valid JSON"));
});

test("rejects a connection name used by two kinds", () => {
  const env = {
    GATO_ALPHA_CONNECTIONS: '{"main":{"token":"a"}}',
    GATO_BETA_CONNECTIONS: '{"main":{"token":"b"}}',
  };
  expect(() => createAdapters([alpha, beta], env, logger)).toThrow(
    new Error(
      'Connection name "main" is in GATO_ALPHA_CONNECTIONS and GATO_BETA_CONNECTIONS. Each connection needs its own name.',
    ),
  );
});

test("rejects a connection name that cannot be a folder name", () => {
  const env = { GATO_ALPHA_CONNECTIONS: '{"../main":{"token":"a"}}' };
  expect(() => createAdapters([alpha], env, logger)).toThrow(
    new Error(
      'GATO_ALPHA_CONNECTIONS.../main: expected a folder name of letters, digits, ".", "_" and "-", not starting with "."',
    ),
  );
});
