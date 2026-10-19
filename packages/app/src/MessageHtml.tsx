// 正则替换出来的 HTML（状态栏、进度条……）放进 iframe 显示。
// sandbox 不给 allow-scripts：卡片里的脚本不会运行，也就碰不到 API Key 和 Tauri 接口。
// 给 allow-same-origin 只是为了外层能量内容高度；没有脚本权限，iframe 里的内容用不上这个来源。
// 只有屏幕上下 1500px 以内的消息才建 iframe，滚远了就销毁，留一个同样高的空白占位，几百条消息不会同时建几百个 iframe。
// shortcut: 不支持卡片 JS；销毁后再滚回来，展开过的 <details> 会收起
import { useEffect, useRef, useState } from "react";

const doc = (html: string) =>
  `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light dark}body{margin:0;display:flow-root;overflow-wrap:anywhere}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}h1{font-size:1.4em}h2{font-size:1.25em}h3{font-size:1.1em}</style><body>${html}`;

export function MessageHtml({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [near, setNear] = useState(false);
  /** 最后一次量到的高度，iframe 销毁后占位用 */
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver>(undefined);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // root 要设成聊天的滚动容器：默认的视口作 root 时，rootMargin 不会放大滚动容器的裁剪范围
    const io = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      root: el.closest(".messages"),
      rootMargin: "1500px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) observer.current?.disconnect();
  }, [near]);
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
    <div ref={box} style={near ? undefined : { height }}>
      {near && (
        <iframe
          ref={frame}
          className="message-html"
          title="message"
          sandbox="allow-same-origin"
          srcDoc={doc(html)}
          style={{ height }}
          onLoad={onLoad}
        />
      )}
    </div>
  );
}
