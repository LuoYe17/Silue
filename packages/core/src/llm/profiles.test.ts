import { describe, expect, test } from "vitest";
import { DocStore } from "../store/doc-store.ts";
import { nodeSqliteDriver } from "../testing/node-sqlite.ts";
import {
  activeProviderProfile,
  listProviderProfiles,
  PROVIDERS,
  removeProviderProfile,
  saveProviderProfile,
  setActiveProviderProfile,
} from "./profiles.ts";

const openStore = () => DocStore.open(nodeSqliteDriver(), "dev-a");
const relay = {
  name: "中转站",
  baseUrl: " https://relay.example.com ",
  model: "m1",
  thinking: "default" as const,
};
const official = {
  name: "官方",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  thinking: "low" as const,
};

describe("接口配置", () => {
  test("新建、按创建顺序列出、修改不改创建时间", async () => {
    const store = await openStore();
    const a = await saveProviderProfile(store, relay);
    const b = await saveProviderProfile(store, official);
    const before = await listProviderProfiles(store);
    expect(before.map((p) => p.id)).toEqual([a, b]);
    expect(before[0]?.baseUrl).toBe("https://relay.example.com");

    await saveProviderProfile(store, { ...relay, id: a, model: "m2" });
    const after = await listProviderProfiles(store);
    expect(after.map((p) => p.id)).toEqual([a, b]);
    expect(after[0]).toMatchObject({ model: "m2", createdAt: before[0]?.createdAt });
  });

  test("当前配置：没选过用第一套，选了用选的，选的被删了退回第一套", async () => {
    const store = await openStore();
    expect(await activeProviderProfile(store)).toBeUndefined();
    const a = await saveProviderProfile(store, relay);
    const b = await saveProviderProfile(store, official);
    expect((await activeProviderProfile(store))?.id).toBe(a);
    await setActiveProviderProfile(store, b);
    expect((await activeProviderProfile(store))?.id).toBe(b);
    await removeProviderProfile(store, b);
    expect((await activeProviderProfile(store))?.id).toBe(a);
  });

  test("同步来的数据缺字段、档位不认识时补齐", async () => {
    const store = await openStore();
    await store.put(PROVIDERS, "x", { name: "旧版本写的", thinking: "ultra" });
    expect(await listProviderProfiles(store)).toEqual([
      { id: "x", name: "旧版本写的", baseUrl: "", model: "", thinking: "default", createdAt: 0 },
    ]);
  });
});
