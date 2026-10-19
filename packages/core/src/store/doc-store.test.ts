import { describe, expect, test } from "vitest";
import { nodeSqliteDriver } from "../testing/node-sqlite.ts";
import { DocStore } from "./doc-store.ts";

// 可控的时钟：每次调用返回 t，测试里手动拨
function fakeTime(start = 1_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

async function openStore(deviceId = "dev-a", time = fakeTime()) {
  const driver = nodeSqliteDriver();
  const store = await DocStore.open(driver, deviceId, time.now);
  return { driver, store, time };
}

describe("DocStore", () => {
  test("建表并记下 schema 版本；重复打开不会出错", async () => {
    const driver = nodeSqliteDriver();
    await DocStore.open(driver, "a");
    await DocStore.open(driver, "a");
    expect(await driver.select("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
  });

  test("put 新建和局部修改，get 读回", async () => {
    const { store } = await openStore();
    await store.put("characters", "c1", { name: "沈青竹", description: "旧" });
    await store.put("characters", "c1", { description: "新" });
    const doc = await store.get("characters", "c1");
    expect(doc?.data).toEqual({ name: "沈青竹", description: "新" });
    expect(doc?.clocks.description?.[0]).toBeGreaterThan(doc?.clocks.name?.[0] ?? Infinity);
  });

  test("系统时间往回调，同一字段的新写入仍然胜出", async () => {
    const { store, time } = await openStore();
    await store.put("x", "1", { v: "first" });
    time.t = 10; // 往回调
    await store.put("x", "1", { v: "second" });
    const doc = await store.get("x", "1");
    expect(doc?.data.v).toBe("second");
  });

  test("并发 put 同一文档不会互相覆盖", async () => {
    const { store } = await openStore();
    await Promise.all([
      store.put("x", "1", { a: 1 }),
      store.put("x", "1", { b: 2 }),
      store.put("x", "1", { c: 3 }),
    ]);
    expect((await store.get("x", "1"))?.data).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("list 按字段过滤，不返回已删除的", async () => {
    const { store } = await openStore();
    await store.insertMany([
      { collection: "messages", id: "m1", data: { chatId: "c1", content: "a" } },
      { collection: "messages", id: "m2", data: { chatId: "c1", content: "b" } },
      { collection: "messages", id: "m3", data: { chatId: "c2", content: "c" } },
    ]);
    await store.remove("messages", "m2");
    const docs = await store.list("messages", { chatId: "c1" });
    expect(docs.map((d) => d.id)).toEqual(["m1"]);
    expect(await store.get("messages", "m2")).toBeUndefined();
  });

  test("按聊天取消息用上了 docs_chat 索引", async () => {
    const { driver } = await openStore();
    const plan = driver.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM docs WHERE collection = ? AND deleted = 0 AND json_extract(data, '$.chatId') = ?",
      )
      .all("messages", "c1")
      .map((r) => String(r.detail));
    expect(plan.join("\n")).toContain("docs_chat");
  });

  test("list 拒绝不是标识符的字段名", async () => {
    const { store } = await openStore();
    await expect(store.list("x", { "a') OR 1=1 --": 1 })).rejects.toThrow("invalid field name");
  });

  test("insertMany 超过一批（500 条）也能全部写入，id 重复时报错", async () => {
    const { store } = await openStore();
    const docs = Array.from({ length: 1203 }, (_, i) => ({
      collection: "messages",
      id: `m${i}`,
      data: { chatId: "c", i },
    }));
    await store.insertMany(docs);
    expect(await store.list("messages", { chatId: "c" })).toHaveLength(1203);
    await expect(
      store.insertMany([{ collection: "messages", id: "m0", data: {} }]),
    ).rejects.toThrow();
  });

  test("删除后再 put 会恢复文档", async () => {
    const { store } = await openStore();
    await store.put("x", "1", { a: 1 });
    await store.remove("x", "1");
    await store.put("x", "1", { b: 2 });
    expect((await store.get("x", "1"))?.data).toEqual({ a: 1, b: 2 });
  });

  test("changesSince 按顺序列出本机改动，包括删除", async () => {
    const { store } = await openStore();
    await store.put("x", "1", { a: 1 });
    await store.put("x", "2", { a: 2 });
    await store.remove("x", "1");
    const changes = await store.changesSince(0);
    expect(changes.map((d) => [d.id, d.deleted, d.seq])).toEqual([
      ["2", false, 2],
      ["1", true, 3],
    ]);
    expect((await store.changesSince(2)).map((d) => d.id)).toEqual(["1"]);
  });

  test("重新打开后 seq 接着往上加", async () => {
    const driver = nodeSqliteDriver();
    const first = await DocStore.open(driver, "a");
    await first.put("x", "1", { a: 1 });
    const second = await DocStore.open(driver, "a");
    expect((await second.put("x", "2", { a: 2 })).seq).toBe(2);
  });

  test("两台设备互相同步后数据一致", async () => {
    const a = (await openStore("dev-a", fakeTime(1_000))).store;
    const b = (await openStore("dev-b", fakeTime(2_000))).store;
    await a.put("characters", "c1", { name: "A 起的名字", description: "A 的描述" });
    for (const d of await a.changesSince(0)) await b.applyRemote(d);
    // 离线各改一个字段，b 还删掉了另一个文档
    await a.put("characters", "c1", { name: "A 改名" });
    await b.put("characters", "c1", { description: "B 改描述" });
    await b.put("characters", "c2", { name: "只在 B" });

    for (const d of await a.changesSince(0)) await b.applyRemote(d);
    for (const d of await b.changesSince(0)) await a.applyRemote(d);

    for (const store of [a, b]) {
      expect((await store.get("characters", "c1"))?.data).toEqual({
        name: "A 改名",
        description: "B 改描述",
      });
      expect((await store.get("characters", "c2"))?.data).toEqual({ name: "只在 B" });
    }
  });

  test("收到时钟更快的设备的改动后，本机后续写入仍然更新", async () => {
    const a = (await openStore("dev-a", fakeTime(1_000))).store;
    const b = (await openStore("dev-b", fakeTime(999_999))).store;
    await b.put("x", "1", { v: "b" });
    for (const d of await b.changesSince(0)) await a.applyRemote(d);
    await a.put("x", "1", { v: "a later" });
    expect((await a.get("x", "1"))?.data.v).toBe("a later");
  });
});
