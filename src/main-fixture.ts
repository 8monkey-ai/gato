// Preloaded by main.test.ts: a connection whose start never ends, and no network.
import { registerChannelType } from "./channels/registry.ts";

globalThis.fetch = Object.assign(() => Promise.reject(new Error("offline")), {
  preconnect: fetch.preconnect,
});

registerChannelType({
  type: "fake-slow-start",
  create: (id) =>
    Promise.resolve({
      id,
      maxTextLength: 4096,
      supportsVideo: false,
      start: () => {
        console.log("fixture.start_waiting");
        return new Promise<void>(() => {});
      },
      stop: () => Promise.resolve(),
      send: () => Promise.reject(new Error("not used")),
      fetchAttachment: () => Promise.reject(new Error("not used")),
    }),
});
