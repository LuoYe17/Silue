# Agent Note: 后台生成默认由 Durable Object 代跑，iOS 后台下载作补充

Status: proposed

## Problem

在 iOS 上，用户发出消息后切到别的 App，系统只会给后台留很短的运行时间（几十秒，系统不保证给多少），之后网络连接就断了。RP 的回复动不动上千字，一条没生成完就断很常见。另外，用户在多任务界面划掉 App 时，iOS 会取消后台传输（https://tessl.io/registry/dpearson2699/swift-ios-skills/3.6.1/files/skills/ios-networking/references/background-websocket.md ）。

Windows 上合上笔记本盖子也会遇到同样的问题。

## Proposal

两种方式都做，按下面的规则选：

| 条件 | 方式 |
|---|---|
| 配置了 Worker，没开直连模式 | Durable Object 代跑（默认） |
| 没配置 Worker，或开了「直连模式」 | iOS：切到后台时改用系统后台下载，生成完发本地通知；Windows：直接请求 |

先做代跑，后台下载排在它后面。

### Durable Object 代跑

1. 客户端把这一轮的请求交给 Worker，Worker 转给这段聊天对应的 Durable Object（DO）。
2. DO 向模型发请求，一边接收一边写进 DO 自带的 SQLite。客户端在前台时，DO 把收到的内容实时转发给客户端。
3. 客户端断开后，DO 继续把回复接收完。
4. 手机回到前台，或者换到另一台设备，客户端从断开的位置继续读。
5. 读完、写进本地数据库之后，DO 删掉这一轮的内容。

有据可查的事实：

- DO 在有未完成的出站 fetch 时不会被回收，但每个这样的操作最多算 15 分钟（https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ）。
- CPU 时间默认 30 秒，每来一个新请求重新计时（https://developers.cloudflare.com/durable-objects/platform/limits/ ）。
- Cloudflare Agents SDK 已有断线重连后继续接收的功能，可以参考（https://developers.cloudflare.com/changelog/2025-11-26-agents-resumable-streaming/ ）。

第一版不做「生成完毕」的推送通知，因为远程推送需要 APNs 证书和推送服务。回到 App 就能看到结果。

### iOS 后台下载（直连模式）

- 写一个 Tauri 的 Swift 插件，在 App 切到后台时把这一轮请求改成后台 URLSession 的上传任务：请求体先写成文件，不再流式接收。拿到结果后，通过 `tauri-plugin-notification`（https://v2.tauri.app/plugin/notification/ ）发一条本地通知。
- 切到后台之前已经收到的部分保留下来；后台任务失败时，回来可以点「继续」接着生成。

## Alternatives considered

- **只做 iOS 后台下载** — 最强的理由：API Key 和提示词不经过任何中转，从头到尾端到端加密。否掉作为默认的原因：用户划掉 App 时，后台传输会被取消；它也只管 iOS，Windows 合上盖子照样会断；Tauri 插件能不能接到 AppDelegate 的 `handleEventsForBackgroundURLSession` 回调，没人验证过。所以保留作直连模式下的补充。
- **只做代跑** — 最强的理由：一套代码就能管所有平台。否掉的原因：开发者选了两种都做，给不想让 API Key 经过 Worker 的人留一条路。
- **断了就保留已生成的部分，回来点「继续」** — 最强的理由：最简单，有缓存撑着，继续生成的花费也低。否掉作为主方案的原因：开发者要求切到后台也能自动生成完。这个做法保留下来，作为后台任务失败时的兜底。
- **普通 Worker（不用 Durable Object）配合 `waitUntil`** — 最强的理由：比 DO 简单。否掉的原因：客户端断开后，`waitUntil` 最多只能再撑 30 秒（https://developers.cloudflare.com/workers/platform/limits/ ），不够生成一条长回复。

## Acceptance criteria

- 代跑：在 iPhone 上发出消息后立刻划掉 App，过 2 分钟再打开，能看到完整的回复，而且和流式显示的版本一致。
- 代跑：在电脑上发出消息，在手机上打开同一段聊天，能接着看到正在生成的回复。
- 直连模式：切到后台后，生成完会收到本地通知，回到 App 能看到完整回复。
- 客户端读完以后，DO 的存储里不再留有这一轮的内容。

## Risks

- **代跑不是端到端加密**：这一轮的提示词和 API Key 会以明文经过用户自己的 Worker。Worker 在用户自己的账号里，不经过第三方，但要在设置里说清楚。
- **DO 的长连接能否保证跑完**：「客户端断开后，DO 里的 fetch 一定会跑完」这一点文档没有明说，未核实，要实测。
- **免费额度**：每轮请求都会算 Worker 和 DO 的请求次数，以及 DO 的运行时长，需要核对日常使用会不会超额。
- **Swift 插件没人做过**：后台下载插件没找到现成的 Tauri 示例，可能做不成。做不成的话，直连模式就只能断了之后点「继续」。
