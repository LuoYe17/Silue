// core 的 tsconfig 不带 DOM 类型。这里只声明浏览器、WebView、Node 24 和 Cloudflare Workers 都有的全局函数，
// 要用新的全局 API 时在这里加，并确认四个环境都支持。

declare function atob(data: string): string;
declare function btoa(data: string): string;

declare const crypto: {
  randomUUID(): string;
};
