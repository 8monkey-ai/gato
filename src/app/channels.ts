import { z } from "zod";

import type { ChannelAdapter } from "../channel/adapter.ts";
import type { ChannelRegistration } from "../channel/registry.ts";
import { type Env, json, readEnv } from "../config/env.ts";
import { folderName } from "../conversation/state.ts";
import type { Logger } from "../log/logger.ts";

/** Creates an adapter for each connection in the variable of each kind. A kind whose variable is unset is disabled. */
export function createAdapters(
  registrations: readonly ChannelRegistration[],
  env: Env,
  logger: Logger,
): ChannelAdapter[] {
  const envVarOf = new Map<string, string>();
  return registrations.flatMap((registration) => {
    const { kind, envVar, schema } = registration;
    const connections = readEnv(
      envVar,
      json(z.record(folderName, schema)).optional(),
      env,
    );
    return Object.entries(connections ?? {}).map(([name, config]) => {
      const other = envVarOf.get(name);
      if (other) {
        throw new Error(
          `Connection name ${JSON.stringify(name)} is in ${other} and ${envVar}. Each connection needs its own name.`,
        );
      }
      envVarOf.set(name, envVar);
      const host = { logger: logger.child({ kind, connection: name }) };
      return registration.create(name, config, host);
    });
  });
}
