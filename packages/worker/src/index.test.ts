import { expect, test } from "vitest";
import worker from "./index.ts";

test("/health 返回 ok", async () => {
  const res = await worker.fetch(new Request("https://silue.test/health"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ app: "Silue", ok: true });
});

test("未知路径返回 404", async () => {
  const res = await worker.fetch(new Request("https://silue.test/nope"));
  expect(res.status).toBe(404);
});
