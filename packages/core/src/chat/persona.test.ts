import { expect, test } from "vitest";
import { setActiveProviderProfile } from "../llm/profiles.ts";
import { DocStore } from "../store/doc-store.ts";
import { nodeSqliteDriver } from "../testing/node-sqlite.ts";
import { loadPersona, savePersona } from "./persona.ts";

test("人设：没设置时为空；保存时去掉首尾空白；和同一份设置里的其他字段互不覆盖", async () => {
  const store = await DocStore.open(nodeSqliteDriver(), "dev-a");
  expect(await loadPersona(store)).toEqual({ name: "", description: "" });
  await setActiveProviderProfile(store, "p1");
  await savePersona(store, { name: " 阿叶 ", description: "店员。\n" });
  await setActiveProviderProfile(store, "p2");
  expect(await loadPersona(store)).toEqual({ name: "阿叶", description: "店员。" });
  expect((await store.get("settings", "app"))?.data).toMatchObject({ activeProviderId: "p2" });
});
