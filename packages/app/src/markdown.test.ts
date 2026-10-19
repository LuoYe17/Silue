import { expect, test } from "vitest";
import { htmlMarkdown, textMarkdown } from "./markdown.ts";

test("没被正则改过的消息：HTML 被转义，链接和图片不渲染，单个换行也换行", () => {
  const out = textMarkdown.render(
    '<img src=x onerror="alert(1)">\n[点我](javascript:alert(1)) ![图](http://x/a.png)',
  );
  expect(out).not.toMatch(/<img|<a /);
  expect(out).toContain("&lt;img");
  expect(out).toContain("<br>");
});

test("正则改过的消息：保留 HTML，Markdown 照样生效", () => {
  expect(htmlMarkdown.render('**粗**<span style="color:red">「嗨」</span>')).toBe(
    '<p><strong>粗</strong><span style="color:red">「嗨」</span></p>\n',
  );
});
