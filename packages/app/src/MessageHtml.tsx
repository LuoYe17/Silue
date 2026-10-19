// 正则替换出来的 HTML（状态栏、进度条……）放进 iframe 显示。
// sandbox 不给 allow-scripts：卡片里的脚本不会运行，也就碰不到 API Key 和 Tauri 接口。
// 给 allow-same-origin 只是为了外层能量内容高度；没有脚本权限，iframe 里的内容用不上这个来源。
// shortcut: 每条消息一个 iframe，不支持卡片 JS；几百条消息卡顿时改成只渲染屏幕上的（见 card-html-sandbox 笔记）
import { useEffect, useRef, useState } from "react";

const doc = (html: string) =>
  `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light dark}body{margin:0;display:flow-root;white-space:pre-wrap;overflow-wrap:anywhere}</style><body>${html}`;

export function MessageHtml({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver>(undefined);

  useEffect(() => () => observer.current?.disconnect(), []);

  const onLoad = () => {
    const iframe = frame.current;
    const body = iframe?.contentDocument?.body;
    if (!iframe || !body) return;
    // 字体和颜色跟外面的消息一致
    const style = getComputedStyle(iframe);
    body.style.font = style.font;
    body.style.color = style.color;
    observer.current?.disconnect();
    // 展开、收起 <details> 时高度会变
    observer.current = new ResizeObserver(() =>
      setHeight(Math.ceil(body.getBoundingClientRect().height)),
    );
    observer.current.observe(body);
  };

  return (
    <iframe
      ref={frame}
      className="message-html"
      title="message"
      sandbox="allow-same-origin"
      srcDoc={doc(html)}
      style={{ height }}
      onLoad={onLoad}
    />
  );
}
