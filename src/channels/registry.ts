import type { ChannelType } from "./channel.ts";

const types = new Map<string, ChannelType>();

export function registerChannelType(type: ChannelType) {
  if (types.has(type.type))
    throw new Error(`Channel type ${type.type} is already registered`);
  types.set(type.type, type);
}

export function channelType(type: string): ChannelType | undefined {
  return types.get(type);
}

export function channelTypeNames(): string[] {
  return [...types.keys()];
}
