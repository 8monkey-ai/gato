import { expect, test } from "bun:test";

import { createEnvReader } from "../config/env.ts";
import { readSettings } from "../config/settings.ts";
import { createLogger } from "../log.ts";
import { verifyModels } from "./models-check.ts";

const settings = readSettings(
  createEnvReader({
    GATO_MODEL: "base/model",
    GATO_SUMMARY_MODEL: "summary/model",
    GATO_AUDIO_MODEL: "audio/model",
  }),
);
const log = createLogger({}, () => {});

test("known model ids are verified and unknown ids stop startup", async () => {
  const known = new Set(["base/model", "summary/model", "audio/model"]);
  expect(await verifyModels(settings, log, () => Promise.resolve(known))).toBe(
    "verified",
  );
  await expect(
    verifyModels(settings, log, () => Promise.resolve(new Set(["base/model"]))),
  ).rejects.toThrow("Unknown OpenRouter model ids: summary/model, audio/model");
});

test("a failed model list leaves the models unverified", async () => {
  expect(
    await verifyModels(settings, log, () => Promise.reject(new Error("down"))),
  ).toBe("unverified");
});
