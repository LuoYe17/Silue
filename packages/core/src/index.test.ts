import { expect, test } from "vitest";
import { APP_NAME } from "./index.ts";

test("APP_NAME", () => {
  expect(APP_NAME).toBe("Silue");
});
