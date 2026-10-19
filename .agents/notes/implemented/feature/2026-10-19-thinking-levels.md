# Agent Note: 思考深度先只换算 OpenAI 兼容接口的 reasoning_effort，按接口地址认 DeepSeek 和 Gemini 官方

Status: implemented

## Problem

开发者离开 Tavo 的第二个原因是不能调思考深度（[思考深度](../../proposed/feature/2026-10-19-thinking-depth-levels.md)）。目前 Silue 只有 OpenAI 兼容接口（[OpenAI 兼容接口](2026-10-19-openai-compatible-chat.md)），它控制思考的参数是 `reasoning_effort`，但各家能填的值不一样，2026-10-19 查的官方文档：

| 接口 | 能填的值 | 默认 | 来源 |
|---|---|---|---|
| DeepSeek 官方 | `none`（关）、`low`、`high`、`max`；`minimal` 当 `low`，`medium`、`xhigh` 当 `high` | `high` | https://api-docs.deepseek.com/api/create-chat-completion |
| Gemini 官方的 OpenAI 兼容地址 | `minimal`、`low`、`medium`、`high`；`none` 只对 2.5 系列有效，2.5 Pro 和 3 系列关不掉思考 | 模型自己的默认 | https://ai.google.dev/gemini-api/docs/openai |
| OpenAI 官方 | 随模型不同，可能有 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；填了模型不支持的值返回 HTTP 400 | 随模型不同 | https://developers.openai.com/api/docs/guides/reasoning |

DeepSeek 官方 `/models` 接口也返回了每个模型支持的档位：`deepseek-flash` 和 `deepseek-v4-pro` 都是 `"effort":{"supported_levels":["low","high","max"],"default_level":"high"}`。

开发者用的中转站对思考参数不起作用（实测见 [OpenAI 兼容接口](2026-10-19-openai-compatible-chat.md)）。

## Decision

- 档位：`default`（默认）/ `off`（关）/ `low`（低）/ `medium`（中）/ `high`（高）/ `max`（最大）。`default` 不发 `reasoning_effort`，由模型自己决定，是新设置的初始值。其余档位一定会发参数。
- 代码在 `packages/core/src/llm/thinking.ts`：`thinkingDialect(baseUrl)` 按接口地址的域名认出是哪家，`reasoningEffort(baseUrl, level)` 查换算表：

  | 档位 | DeepSeek（`api.deepseek.com`） | Gemini（`generativelanguage.googleapis.com`） | 其他（含所有中转站） |
  |---|---|---|---|
  | 关 | `none` | `none` | `none` |
  | 低 | `low` | `low` | `low` |
  | 中 | `high`（没有中档） | `medium` | `medium` |
  | 高 | `high` | `high` | `high` |
  | 最大 | `max` | `high`（没有最大档） | `max` |

- `reasoning_effort` 放在请求体最后，`default` 时请求体和加这个功能之前逐字相同（已有的两份标准答案没有变）。
- 档位跟接口地址、模型名一起存在 `settings` 集合，会同步。读出来的值不在档位列表里（比如别的设备上更新的版本写的）时按 `default` 处理。
- 设置里的下拉框下面显示实际发送的值，比如「实际发送 reasoning_effort: high」，选「中」接 DeepSeek 时能看出来实际是 `high`。
- 用量那一行在接口返回思考 token 数时加上「（其中思考 N）」。
- 标准答案：`packages/core/src/llm/__golden__/thinking-levels.txt` 列出三家每个档位的请求体结尾。

## Alternatives considered

- **从 `/models` 接口读每个模型支持的档位，动态生成选项** — 最强的理由：DeepSeek 官方已经在 `/models` 里返回了 `supported_levels`，不用手写换算表，模型更新了也跟得上。否掉的原因：只有 DeepSeek 返回这个字段，中转站和 Gemini、OpenAI 都没有；还是要手写表兜底。以后可以在有这个字段时优先用它。
- **通用接口的「最大」发 `xhigh`** — 最强的理由：OpenAI 的旧模型只认到 `xhigh`。否掉的原因：OpenAI 文档的取值里也有 `max`，DeepSeek 也认 `max`；同名直接发最好理解，不支持的由接口报错，用户换一档就行。

## Consequences

- 2026-10-19 用官方 DeepSeek（`deepseek-flash`）实测，同一句短提示（写 300 字小说开头），脚本直接请求：

  | `reasoning_effort` | 思考 token | 第一个正文字 | 发完 |
  |---|---|---|---|
  | `none` | 0（没有思考内容） | 1.0s | 2.7s |
  | `low` | 35 | 1.2s | 3.8s |
  | `high` | 725 | 5.7s | 6.5s |
  | `max` | 2858 | 12.0s | 12.8s |

  官方接口 0.4 秒就返回响应头，流式返回里有 `prompt_cache_hit_tokens`、`prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens`。
- 同一天在真 App 里用官方 DeepSeek（`deepseek-flash`，低档）接着万象那段聊天连发两轮「继续」：
  - 设置里选「中」时提示「实际发送 reasoning_effort: high」，选「低」时是 `low`。
  - 第一轮：1.0 秒开始思考，2.5 秒出正文，9.6 秒写完；用量「输入 6962（缓存命中 0）· 输出 1232（其中思考 203）」。
  - 第二轮：用量「输入 7995（缓存命中 6912）· 输出 1950（其中思考 298）」，命中 86%。这是 [缓存排布](../../proposed/feature/2026-10-19-prompt-cache-layout.md) 的第一个实测数据：系统提示和旧消息在前、只往后追加的拼法，DeepSeek 的自动缓存能命中。
- 换算表靠域名认人：用户通过中转站用 DeepSeek 时走「其他」那一列，「中」会发 `medium`（DeepSeek 自己会当成 `high`）。
- 测试：`thinking.test.ts` 3 个（认域名、换算表标准答案、`default` 不改请求体）。
- 还没做：
  - Claude、Gemini 原生接口的思考参数（还没有原生接口）。
  - 高级设置里直接填原始参数、覆盖换算结果。
  - 每段聊天单独设档位（现在是全局设置）。
