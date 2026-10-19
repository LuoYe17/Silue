# Agent Note: 先接 OpenAI 兼容接口：core 只拼请求和解析流，App 从 Rust 端发请求

Status: implemented

## Problem

存储层做好以后（[本地存储](../architecture/2026-10-19-doc-store.md)），App 还不能和模型对话。[第一版范围](../../proposed/feature/2026-10-19-v1-scope.md) 要求 OpenAI 兼容接口和各家原生接口都做完整。开发者日常用的是一个 OpenAI 兼容的中转站（不是官方接口），模型 `gemini-3.8-flash`。2026-10-19 对这个中转站实测：

- `/v1/models` 返回的是 Anthropic 的列表格式。
- `/v1/chat/completions`（OpenAI 格式）和 `/v1/messages`（Anthropic 格式）都能用。
- `max_tokens: 200` 没有生效。只回一个字时，用量里的输出也有 1146 个 token，思考用掉的 token 算在输出里。
- 流式返回是标准的 OpenAI SSE：文字在 `choices[0].delta.content`，用量在最后一块（`choices` 为空），最后是 `data: [DONE]`。没有返回思考内容，也没有缓存命中数。

这些是中转站自己的行为，不能当成 Gemini 官方接口的行为。

另外有两个限制：

- WebView 里直接 `fetch` 第三方地址会被跨域规则拦住，CSP 也只允许 `'self'`，而中转站不一定配了 CORS。
- [第一版范围](../../proposed/feature/2026-10-19-v1-scope.md) 要求 API Key 存在系统安全存储里，不明文进 SQLite。

## Decision

### core：只拼请求、只解析返回，不发网络请求

- `packages/core/src/llm/openai.ts`：
  - `openAiChatRequest(config, messages)` 返回 `{ url, headers, body }`。请求体固定是 `model`、`messages`、`stream: true`、`stream_options: { include_usage: true }`，不发 `max_tokens`、温度、思考参数。
  - `chatCompletionsUrl(baseUrl)`：只填了域名时补 `/v1`；带了路径就照用（比如 Gemini 官方兼容地址 `.../v1beta/openai`）；已经以 `/chat/completions` 结尾的不再加。
  - `SseDecoder` 把一块块收到的文本切成 SSE 事件，兼容 CRLF 和任意切分；`parseOpenAiEvent` 把一个事件变成 `text`、`reasoning`、`usage`、`finish`。思考内容认 `reasoning_content`（DeepSeek）和 `reasoning`（OpenRouter 等）两种字段；用量里的 `prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens` 有就带上，没有就不带（界面显示「未知」）。
  - 出错抛 `ProviderError`，`code` 是 `http`（状态码不是 2xx，`detail` 取 `error.message`，取不到用原文前 500 字）、`api`（流里夹着错误对象）、`bad_response`（不是 JSON 或结构不对）。界面按 `code` 翻译。
- `packages/core/src/prompt/chat-prompt.ts` 的 `buildChatPrompt`：
  - 顺序：系统提示 → 角色描述 → 性格 → 场景 → 示例对话（合成一条 system 消息）→ 当前这条线的聊天记录 → `post_history_instructions`（放在最后）。不变的在前、每轮变的在后，按 [缓存排布](../../proposed/feature/2026-10-19-prompt-cache-layout.md) 的思路。
  - 卡片没有 `system_prompt` 时用 SillyTavern 默认的 Main Prompt；有的话替换掉默认的，`{{original}}` 换成默认提示（V2 规格）。
  - 宏只换 `{{char}}`、`{{user}}`、`<BOT>`、`<USER>`，不区分大小写。
  - 还没有预设、世界书、用户人设、正则（代码里有 `shortcut:` 注释）。

### 标准答案测试

- `packages/core/src/llm/__golden__/openai-chat-request.txt` 和 `packages/core/src/prompt/__golden__/basic-card.json` 存着完整的请求（URL、请求头、请求体逐字），用 Vitest 的 `toMatchFileSnapshot` 比较。有意修改时跑 `npm test -- -u` 更新，并在提交里写明原因。这是 [标准答案测试](../../proposed/testing/2026-10-19-golden-prompt-tests.md) 的第一部分，用的是自己写的测试卡「小橘」，不是开发者的万象卡。
- 2026-10-19 验证过：在拼系统提示的 `join("\n\n")` 里多加一个空格，标准答案测试失败。
- `biome.json` 排除了 `**/__golden__`：biome 会把 `.json` 标准答案重新排版，排完就和请求体对不上（本次实际发生过一次）。
- 缓存前缀测试：同一段聊天连续拼两轮，第一轮请求体里消息数组之前的部分（含全部旧消息）是第二轮请求体的前缀。

### App

- 请求从 Rust 端发：`tauri-plugin-http` 2.8.3，前端用 `@tauri-apps/plugin-http` 的 `fetch`，不受 WebView 跨域和 CSP 限制。权限 `http:default` 放开 `https://*` 和 `http://*`，因为接口地址是用户自己填的。
- API Key 存在系统凭据管理器：Rust 端用 `keyring` 4.2.0 的经典接口（`Entry::new(service, name)`），加了两个命令 `secret_get`、`secret_set`（空字符串表示删除），服务名是 `io.github.luoye17.silue`，Key 的名字是 `provider.apiKey`。
- 接口地址和模型名存在数据库的 `settings` 集合（id `provider`），以后跟着同步；API Key 不同步。
- `packages/app/src/provider.ts` 的 `streamChat` 发请求、边收边解析、逐个回调事件。`App.tsx` 里发消息后自动生成回复，回复挂在用户消息下面；「重新生成」在同一个父消息下再生成一条，成为兄弟（左右切换）。生成中可以停止。停止或出错时，已经收到的文字照样存成一条消息，不丢。
- 生成的消息额外存 `model`、`usage`（有就存）、`reasoning`（有就存），界面在回复下面显示输入、缓存命中、输出的 token 数。

## Alternatives considered

- **在 WebView 里直接 `fetch`，CSP 放开 `connect-src`** — 最强的理由：少一个 Rust 插件，编译更快。否掉的原因：中转站和官方接口不一定返回 CORS 头（Anthropic 官方要额外的请求头才允许浏览器调用），用户填的地址能不能用要看对方配置。从 Rust 端发不受这个限制。
- **core 里直接调 `fetch` 发请求** — 最强的理由：App 和以后的 Worker（后台生成）都能直接用，少一层。否掉的原因：core 的类型检查不带 DOM（[工具链](../process/2026-10-19-monorepo-toolchain.md)），各端的 `fetch` 也不一样（App 用插件的）。只拼请求、只解析返回的话，请求内容能直接做标准答案测试，解析逻辑也能用真实返回的字符串测。
- **API Key 先明文存进 SQLite 或 localStorage** — 最强的理由：不用加 Rust 依赖，iOS 上也一样能用。否掉的原因：违反第一版的隐私底线；加 `keyring` 只多两个十几行的命令。
- **这次就用 Anthropic 格式接这个中转站** — 最强的理由：这个中转站两种格式都支持，Anthropic 格式能显式打缓存断点。否掉的原因：OpenAI 兼容格式几乎所有中转站和 DeepSeek、Gemini 官方都支持，先用它跑通整条链路；各家原生格式按官方文档另外做。

## Consequences

- 收益：
  - 开发者能在 Silue 里用自己的中转站聊天，请求内容有标准答案测试兜底。
  - 2026-10-19 在真 App 里用开发者的中转站和 `gemini-3.8-flash` 试过：设置里填接口地址、模型、API Key 后保存，Key 出现在 Windows 凭据管理器（`provider.apiKey.io.github.luoye17.silue`），刷新页面后能读回来；万象卡新建聊天发「随机来两个」，回复按开场白的要求给出两个方案，用量显示「输入 5158（缓存命中 未知）· 输出 1571」。
  - core 新增 18 个测试：URL 拼接 5 个、请求标准答案 1 个、流式解析 6 个（用中转站的真实返回，切成 7 字一块、CRLF、末尾无空行、思考和缓存用量、注释行、错误）、HTTP 错误 1 个、提示词 5 个（标准答案、缓存前缀、`{{original}}`、`post_history_instructions`、宏）。
- 代价和限制：
  - `keyring` 的经典接口不支持 iOS，做 iOS 时要换成 `keyring-core` 加 `apple-native-keyring-store`（`lib.rs` 里有 `shortcut:` 注释）。
  - `http:default` 允许前端请求任意地址。以后做卡片 HTML 沙盒时，沙盒里的内容不能拿到 Tauri 的 IPC（见 [消息里的 HTML](../../proposed/feature/2026-10-19-card-html-sandbox.md)）。
  - 用户名暂时取这段聊天里最后一条用户消息的名字，没有就用「你」。
  - 不发 `max_tokens`，回复长度由模型默认值决定。
  - 真 App 里这次从发出到出字等了 30 秒以上，没有确认是模型思考慢，还是 HTTP 插件没有边收边交给前端（可能整段收完才交）。
- 还没做：思考深度档位（[思考深度](../../proposed/feature/2026-10-19-thinking-depth-levels.md)）、Claude / Gemini / OpenAI / DeepSeek 原生接口、预设和世界书、花费显示、模型列表下拉。
