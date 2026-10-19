# Agent Note: 技术栈用 Tauri 2 + React + TypeScript + SQLite，一个仓库分三块

Status: proposed

## Problem

Silue 是一个 RP 聊天客户端，第一版只做 Windows 和 iOS。下面这些约束决定了技术栈：

- 开发者没有 Mac。现有的 iOS 环境是 WSL 里的 xtool，只能编译纯 SwiftPM / SwiftUI 项目，用免费 Apple ID 签名。iOS 包可以用开发者自己的自签工具和证书安装，任何 ipa 都能重签。
- 消息里要渲染角色卡和正则产出的 HTML + CSS，带 JS 的放沙盒运行（见 [角色卡渲染](../feature/2026-10-19-card-html-sandbox.md)）。中文 RP 圈的美化卡、状态栏卡都依赖这一点。
- 开发者不写代码，全部由 AI 生成。两套平台代码会让维护量和出错面翻倍。
- 第一版不做 Web，但不想把以后做 Web 的路堵死。

## Proposal

- **外壳**：Tauri 2，一套代码出 Windows 和 iOS。调研时的最新稳定版是 v2.12.4（2026-10-14 发布，数据来自 `gh api repos/tauri-apps/tauri/releases`）。
- **界面**：React + TypeScript（strict 模式）。
- **本地数据**：SQLite，每台设备上的这一份是唯一的主数据。通过 `tauri-plugin-sql` 访问（底层是 sqlx，文档要求 Rust 1.90+，https://v2.tauri.app/plugin/sql/ ）。
- **仓库结构**：一个仓库分三块：
  - `app`：Tauri 外壳和 React 界面
  - `worker`：Cloudflare Worker 和 Durable Object，用于同步和后台代跑
  - `core`：纯 TypeScript 的核心逻辑，不依赖界面和 Tauri，可以单独测试。包括角色卡和世界书解析、提示词拼装、各家模型适配、记忆、同步协议、加密

  `core` 同时给 `app` 和 `worker` 用。目录结构和检查工具已经搭好，见 [工具链](../../implemented/process/2026-10-19-monorepo-toolchain.md)。
- **iOS 出包**：在 GitHub Actions 的 macOS 机器上跑 `xcodebuild archive`，带 `CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`，把 `.app` 放进 `Payload/` 后压缩成 `.ipa`，再由开发者在手机上重签（通用做法见 https://git.tdem.in/MrKai77/Export-unsigned-ipa-files ）。
- **平台范围**：
  - Windows 10 及以上（Tauri 依赖系统的 WebView2）。
  - iPad 可以用，界面跟着屏幕宽度自适应，不单独设计。
  - 不做 Android。
  - 第一版不做 Web。

### 开发顺序

先做 Windows 版，iOS 出包验证往后放（开发者 2026-10-19 决定）。`core` 和 React 界面在两个平台上共用，Windows 上写好的代码之后在 iOS 上照样能用。

### iOS 出包验证（开始做 iOS 之前）

1. 用一个空白 Tauri 2 应用，在 GitHub Actions 上按上面的方法出不签名的 ipa。
2. 用开发者的自签工具装到 iPhone（iOS 27.2）上，能正常打开。
3. 在真机上测一个聊天输入框：键盘弹出时页面不被顶出屏幕，键盘收起后底部不留白，切到后台再切回来布局正常。这三类都有还没修的 issue：
   - https://github.com/tauri-apps/tauri/issues/9907
   - https://github.com/tauri-apps/tauri/issues/10631
   - https://github.com/tauri-apps/tauri/issues/15367
4. 把 `isInspectable` 打开，确认 Windows 上能通过 ios-webkit-debug-proxy 调试 iOS 里的页面；不行就在页面里放一个调试面板（比如 vConsole）。

任何一步走不通，iOS 端就要换外壳（候补是 Capacitor），这篇笔记里 iOS 的部分转成新的笔记。

## Alternatives considered

- **原生 SwiftUI（用 xtool 编 iOS）+ Windows 另写一套** — 最强的理由：iOS 体验最原生；本机就能编译，几秒出包，已经验证过。否掉的原因：
  - 两套代码，开发者靠 AI 写，维护量翻倍。
  - 消息里的 HTML 卡在 SwiftUI 里要给每条消息嵌一个 WKWebView，长聊天会卡。
  - xtool 上 `@Observable` 宏编译失败（xtool issue #197），没有预览也没有模拟器。
- **Capacitor（iOS）+ Tauri 或 Electron（Windows）** — 最强的理由：Capacitor 在 iOS 上比 Tauri 移动端成熟，插件多。否掉的原因：Windows 和 iOS 要各写一套外壳、两套数据库和网络接口；Capacitor v8 要求 Xcode 26+（https://capacitorjs.com/docs/ios ），一样离不开云端 Mac，没省掉 Tauri 的主要成本。
- **Flutter** — 最强的理由：一套 Dart 代码，渲染性能好，三端都支持。否掉的原因：HTML 卡要靠网页控件嵌入，`flutter_inappwebview` 稳定版 6.1.5 是两年前发的（https://pub.dev/packages/flutter_inappwebview ）；Dart 也不如 TypeScript 好让 AI 写。
- **纯 PWA（Safari 添加到主屏幕）** — 最强的理由：不用签名，也不会 7 天过期，别人用最方便。否掉的原因：开发者有自签证书，能装真正的 App；PWA 在 iOS 上切到后台几秒就冻结，正在生成的回复会断。
- **前端用 Vue / Svelte / Solid** — 最强的理由：代码更短、包更小。否掉的原因：AI 生成 React 代码出错最少，生态最大；开发者不懂代码，出错少比包小更重要。

## Acceptance criteria

- 上面「出包验证」的四步全部通过，并把每一步的结果写进这篇笔记。
- `core` 不 import 任何 Tauri、React 或浏览器专有的 API，用一条 lint 规则来保证。
- Windows 安装包和 iOS 的 ipa 都由 GitHub Actions 自动产出，见 [CI 与发布](../process/2026-10-19-ci-and-release.md)。

## Risks

- **出包流程没人验证过**：用 Tauri 生成的 Xcode 工程不签名出包，没有找到别人成功的记录。走不通的话，候补是 Capacitor（同样在 CI 上出包），但 Windows 端要另写一套外壳。验证放到 Windows 版之后，失败的代价是：已经写好的代码里，凡是直接调用 Tauri 接口的部分，iOS 端都要改写。`core` 不依赖 Tauri，不受影响。
- **iOS 键盘和视口 bug**：第一步验证里那三个 issue 还开着。聊天输入框是 RP 里用得最多的地方，修不好会严重影响体验。
- **iOS 调试困难**：没有 Mac，就用不了 Safari Web Inspector，iOS 上的 bug 只能靠调试代理或页面里的调试面板来查。
- **GitHub 的 macOS 机器是否免费**：GitHub 文档说公开仓库使用标准机器免费，但没点名 macOS 是否包括在内，未核实（https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions ）。私有仓库超出额度后，macOS 机器每分钟 $0.062。
