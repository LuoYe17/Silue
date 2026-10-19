// 消息按 Markdown 显示。单个换行也换行（breaks），和 SillyTavern 一样（ST 用 showdown 的 simpleLineBreaks）。
// 不渲染链接和图片：链接在主页面里点了会把整个 App 导航走，图片会去加载网络地址。
// shortcut: 中文紧贴标点的粗体（如「文字**【x】**文字」）按 CommonMark 规则不生效，用户反馈多了再加 markdown-it-cjk-friendly
import MarkdownIt from "markdown-it";

const make = (html: boolean) =>
  new MarkdownIt({ html, breaks: true }).disable(["link", "image", "autolink"]);

/** 没被正则改过的消息：HTML 原样转义，可以直接放进页面 */
export const textMarkdown = make(false);
/** 正则改出了 HTML 的消息：认 HTML，结果只能放进不能跑脚本的 iframe */
export const htmlMarkdown = make(true);
