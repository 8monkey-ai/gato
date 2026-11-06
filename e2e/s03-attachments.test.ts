import { afterEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readChat, waitUntil } from "./support/app.ts";
import {
  contentText,
  isPreparationCall,
  type LlmRequest,
} from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const photo = {
  photo: [{ file_id: "photo-1", file_unique_id: "p1", width: 9, height: 9 }],
};
const voice = {
  voice: {
    file_id: "voice-1",
    file_unique_id: "v1",
    duration: 2,
    mime_type: "audio/ogg",
  },
};
const lastUser = (r: LlmRequest) =>
  r.messages.findLast((m) => m.role === "user")!;
const chat = () => readChat(world.dataDir, world.telegram.connectionId, "42");

async function startWithFiles(env: Record<string, string> = {}) {
  world = await createWorld();
  world.telegram.files.set("photo-1", png);
  world.telegram.files.set("voice-1", new Uint8Array([79, 103, 103, 83]));
  world.llm.respond((r) =>
    isPreparationCall(r)
      ? { text: "A red cup on a table." }
      : { text: "Nice." },
  );
  return world.start(env);
}

test("§3 without a preparation model the original image goes to the main call and stays stored", async () => {
  await startWithFiles();
  world.telegram.push(42, { caption: "Look", ...photo });
  await waitUntil(() => world.telegram.sent.length);

  expect(world.llm.requests.filter(isPreparationCall)).toHaveLength(0);
  expect(contentText(lastUser(world.llm.requests[0]!).content)).toBe(
    "Look <image_url>",
  );
  const folder = join(
    world.dataDir,
    world.telegram.connectionId,
    "42",
    "attachments",
  );
  const [file] = await readdir(folder);
  expect([...(await Bun.file(join(folder, file!)).bytes())]).toEqual([...png]);
});

test("§3 a preparation model replaces the file with its text, and the result is saved and reused", async () => {
  await startWithFiles({ IMAGE_PREPARATION_MODEL: "test/vision" });
  world.telegram.push(42, { caption: "Look", ...photo });
  await waitUntil(() => world.telegram.sent.length);
  world.telegram.push(42, { text: "And?" });
  await waitUntil(() => world.telegram.sent.length === 2);

  const preparation = world.llm.requests.filter(isPreparationCall);
  expect(preparation.map((r) => r.model)).toEqual(["test/vision"]);
  const main = world.llm.mainRequests()[1]!;
  const first = main.messages.find((m) => m.role === "user")!;
  expect(contentText(first.content)).toBe(
    'Look [image "photo.jpg" attached. Description of the image by a model: A red cup on a table.]',
  );
  const customer = (await chat()).find((e) => e.tag === "customer");
  expect(customer?.meta.attachments).toMatchObject([
    {
      kind: "image",
      prepared: { model: "test/vision", text: "A red cup on a table." },
    },
  ]);
  expect(customer?.text).toBe("Look");
});

test("§3 categories choose independently: audio is transcribed while images go direct", async () => {
  await startWithFiles({ AUDIO_PREPARATION_MODEL: "test/audio" });
  world.telegram.push(42, voice);
  await waitUntil(() => world.telegram.sent.length);
  world.telegram.push(42, photo);
  await waitUntil(() => world.telegram.sent.length === 2);

  expect(
    world.llm.requests.filter(isPreparationCall).map((r) => r.model),
  ).toEqual(["test/audio"]);
  const main = world.llm
    .mainRequests()[1]!
    .messages.filter((m) => m.role === "user");
  expect(main.map((m) => contentText(m.content))).toEqual([
    "[audio attached. Transcript of the audio by a model: A red cup on a table.]",
    "<image_url>",
  ]);
});

test("§3 a preparation failure is a processing failure and nothing is invented", async () => {
  await startWithFiles({ IMAGE_PREPARATION_MODEL: "test/vision" });
  world.llm.respond((r) =>
    isPreparationCall(r) ? { status: 400 } : { text: "Invented." },
  );
  world.telegram.push(42, photo);

  await waitUntil(async () => (await chat()).some((e) => e.tag === "turn"));
  expect((await chat()).find((e) => e.tag === "turn")?.meta.outcome).toBe(
    "failed",
  );
  expect(world.llm.mainRequests()).toHaveLength(0);
  expect(world.telegram.sent).toHaveLength(0);
});

test("§3 video is recorded and identified to the agent as unsupported", async () => {
  await startWithFiles();
  world.telegram.files.set("video-1", new Uint8Array([1]));
  world.telegram.push(42, {
    video: {
      file_id: "video-1",
      file_unique_id: "x",
      width: 1,
      height: 1,
      duration: 1,
      file_name: "clip.mp4",
    },
  });
  await waitUntil(() => world.telegram.sent.length);

  expect(contentText(lastUser(world.llm.requests[0]!).content)).toBe(
    '[video "clip.mp4": this attachment type is not supported and cannot be viewed]',
  );
  const [video] = (await chat())[0]?.meta.attachments as {
    kind: string;
    file: string;
  }[];
  expect([video?.kind, video?.file.startsWith("attachments/")]).toEqual([
    "video",
    true,
  ]);
});

test("§3 a failed retrieval keeps the message and its reference visible", async () => {
  await startWithFiles();
  world.telegram.push(42, {
    caption: "See this",
    photo: [{ file_id: "missing", file_unique_id: "m", width: 1, height: 1 }],
  });
  await waitUntil(() => world.telegram.sent.length);

  expect(contentText(lastUser(world.llm.requests[0]!).content)).toBe(
    'See this [image "photo.jpg": the file could not be retrieved]',
  );
  const [customer] = await chat();
  const [image] = customer?.meta.attachments as {
    source: string;
    retrievalError: string;
  }[];
  expect(image?.source).toBe("missing");
  expect(image?.retrievalError).toStartWith("The file could not be retrieved");
});

test("§3 an operator attachment stays in history, attributed to the human colleague", async () => {
  world = await createWorld();
  world.respondio.files.set("form.png", png);
  const app = await world.start({}, "respondio");
  const key = world.respondio.signingKey;
  const attachment = {
    type: "image",
    url: world.respondio.fileUrl("form.png"),
    fileName: "form.png",
  };
  await notify(
    app.url,
    "main",
    messageEvent({
      contact: 5,
      traffic: "outgoing",
      text: "Fill this in",
      attachment,
      sender: { source: "user", userId: 3 },
    }),
    key,
  );
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Done" }),
    key,
  );
  await waitUntil(() => world.respondio.sent.length);

  const messages = world.llm
    .mainRequests()[0]!
    .messages.filter((m) => m.role !== "system");
  expect(messages.map((m) => [m.role, contentText(m.content)])).toEqual([
    [
      "assistant",
      "[Human colleague] Fill this in [1 file(s), shown in the next message]",
    ],
    [
      "user",
      "[Files that the operator in the message above sent to the customer. They are not from the customer.] <image_url>",
    ],
    ["user", "Done"],
  ]);
});
