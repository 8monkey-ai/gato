import { expect, test } from "bun:test";

import { listChannels, registerChannel } from "../../src/channel/registry.ts";
import { fakeRegistration } from "../support/fake-adapter.ts";

test("lists the kinds that adapter modules registered", () => {
  registerChannel(fakeRegistration("listed", "GATO_LISTED_CONNECTIONS"));
  const kinds = listChannels().map((registration) => registration.kind);
  expect(kinds).toContain("listed");
});

test("rejects a second registration of the same kind", () => {
  registerChannel(fakeRegistration("twice", "GATO_TWICE_CONNECTIONS"));
  expect(() =>
    registerChannel(fakeRegistration("twice", "GATO_TWICE2_CONNECTIONS")),
  ).toThrow(new Error("Channel kind twice is already registered"));
});
