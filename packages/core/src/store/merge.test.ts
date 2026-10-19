import { describe, expect, test } from "vitest";
import { type Clock, DELETED_FIELD, type DocState, mergeDocs } from "./merge.ts";

const doc = (fields: Record<string, [unknown, Clock]>, deleted?: Clock): DocState => ({
  data: Object.fromEntries(Object.entries(fields).map(([k, [v]]) => [k, v])),
  clocks: {
    ...Object.fromEntries(Object.entries(fields).map(([k, [, c]]) => [k, c])),
    ...(deleted ? { [DELETED_FIELD]: deleted } : {}),
  },
  deleted: deleted !== undefined,
});

describe("mergeDocs", () => {
  test("每个字段各自取时钟更新的一边", () => {
    const a = doc({ name: ["A 改的名字", [5, "a"]], description: ["旧描述", [1, "a"]] });
    const b = doc({ name: ["旧名字", [1, "b"]], description: ["B 改的描述", [6, "b"]] });
    expect(mergeDocs(a, b).data).toEqual({ name: "A 改的名字", description: "B 改的描述" });
  });

  test("时间戳相同时比设备 id", () => {
    const a = doc({ x: ["a", [5, "device-a"]] });
    const b = doc({ x: ["b", [5, "device-b"]] });
    expect(mergeDocs(a, b).data.x).toBe("b");
    expect(mergeDocs(b, a).data.x).toBe("b");
  });

  test("只有一边有的字段直接保留", () => {
    const merged = mergeDocs(doc({ x: [1, [1, "a"]] }), doc({ y: [2, [1, "b"]] }));
    expect(merged.data).toEqual({ x: 1, y: 2 });
  });

  test("删除标记也按时钟比较：删除之后的改动不会让它复活", () => {
    const deleted = doc({ x: [1, [1, "a"]] }, [10, "a"]);
    const editedEarlier = doc({ x: [2, [5, "b"]] });
    expect(mergeDocs(deleted, editedEarlier)).toMatchObject({ deleted: true, data: { x: 2 } });

    const restored: DocState = {
      ...doc({ x: [1, [1, "a"]] }),
      clocks: { x: [1, "a"], [DELETED_FIELD]: [20, "b"] },
    };
    expect(mergeDocs(deleted, restored).deleted).toBe(false);
  });

  test("满足交换律和结合律：任意顺序合并结果都一样", () => {
    const docs = [
      doc({ a: [1, [3, "x"]], b: [1, [1, "x"]] }),
      doc({ a: [2, [2, "y"]], c: [2, [9, "y"]] }, [4, "y"]),
      doc({ b: [3, [7, "z"]], c: [3, [9, "z"]] }),
    ] as const;
    const [x, y, z] = docs;
    const expected = mergeDocs(mergeDocs(x, y), z);
    for (const result of [
      mergeDocs(mergeDocs(y, x), z),
      mergeDocs(x, mergeDocs(y, z)),
      mergeDocs(mergeDocs(z, y), x),
      mergeDocs(y, mergeDocs(z, x)),
    ]) {
      expect(result).toEqual(expected);
    }
    expect(expected.data).toEqual({ a: 1, b: 3, c: 3 });
  });
});
