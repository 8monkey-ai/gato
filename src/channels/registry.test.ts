import { expect, test } from "bun:test";

import {
  channelType,
  channelTypeNames,
  registerChannelType,
} from "./registry.ts";

test("finds registered channel types by name and refuses duplicates", () => {
  const fake = {
    type: "fake",
    create: () => Promise.reject(new Error("unused")),
  };
  registerChannelType(fake);
  expect(channelType("fake")).toBe(fake);
  expect(channelType("unknown")).toBeUndefined();
  expect(channelTypeNames()).toContain("fake");
  expect(() => registerChannelType(fake)).toThrow("already registered");
});
