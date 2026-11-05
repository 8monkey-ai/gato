import type { Channel } from "./channels/channel.ts";
import { createChannel } from "./channels/channel.ts";
import type { Env } from "./config/env.ts";
import { ConfigError } from "./config/env.ts";

const connectionName = /^[a-z0-9_]+$/;

export function readConnections(env: Env) {
  const names = env.list("CONNECTIONS");
  if (names.length === 0)
    throw new ConfigError(
      "Missing CONNECTIONS. Give a comma-separated list of connection names.",
    );
  const channels = new Map<string, Channel>();
  for (const name of names) {
    if (!connectionName.test(name)) {
      throw new ConfigError(
        `Invalid connection name "${name}". Use lowercase letters, digits and "_".`,
      );
    }
    if (channels.has(name))
      throw new ConfigError(
        `Connection "${name}" is listed twice in CONNECTIONS.`,
      );
    const scoped = env.scoped(`CONNECTION_${name.toUpperCase()}_`);
    channels.set(name, createChannel(scoped.string("TYPE"), name, scoped));
  }
  return channels;
}
