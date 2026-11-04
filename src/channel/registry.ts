import type { z } from "zod";

import type { AdapterHost, ChannelAdapter } from "./adapter.ts";

/** Each adapter module registers one, so a new kind needs no change elsewhere. */
export interface ChannelRegistration<Config = unknown> {
  kind: string;
  /** Holds a JSON object keyed by connection name, for example GATO_TELEGRAM_CONNECTIONS. */
  envVar: string;
  /** Validates the settings of one connection. */
  schema: z.ZodType<Config>;
  create(name: string, config: Config, host: AdapterHost): ChannelAdapter;
}

const registrations = new Map<string, ChannelRegistration>();

export function registerChannel<Config>(
  registration: ChannelRegistration<Config>,
): void {
  if (registrations.has(registration.kind)) {
    throw new Error(`Channel kind ${registration.kind} is already registered`);
  }
  registrations.set(registration.kind, registration);
}

export function listChannels(): ChannelRegistration[] {
  return [...registrations.values()];
}
