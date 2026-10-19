# Agent Note: 角色卡自带的世界书：常驻的进不变区，触发的和插在中间的放到聊天记录之后

Status: implemented

## Problem

角色卡导入时会保留 `character_book`（[角色卡导入](2026-10-19-card-import.md)），但拼提示词时（[OpenAI 兼容接口](2026-10-19-openai-compatible-chat.md)）一直没用它。开发者的万象卡有 3 条：

| 条目 | 触发方式 | SillyTavern 里的位置 | 长度 |
|---|---|---|---|
| 万象提醒 | 常驻（`constant: true`） | `extensions.position: 4`、`depth: 1`，插在聊天记录倒数第 1 条前 | 1102 字 |
| OOC / 推进剧情说明 | 关键词「场外」「OOC」「推进剧情」……，`scan_depth: 1` | `position: 4`、`depth: 0` | 568 字 |
| 快进说明 | 关键词「快进」「第二天早上」「几天后」…… | `position: 4`、`depth: 0` | 218 字 |

SillyTavern 按条目设定把内容插到聊天记录中间的某个深度，每轮插入点都在变，前面的缓存就失效了（[缓存排布](../../proposed/feature/2026-10-19-prompt-cache-layout.md)）。

## Decision

代码在 `packages/core/src/prompt/lorebook.ts`，`buildChatPrompt` 自动读卡片的 `character_book`。

- **哪些条目生效**：
  - `enabled` 且内容非空。
  - 常驻（`constant`），或者关键词出现在最近几条消息里。扫几条：条目的 `extensions.scan_depth` 优先，其次书的 `scan_depth`，都没有时用 SillyTavern 的默认值 2。
  - `selective` 且有副关键词时，按 `extensions.selectiveLogic` 判断：0 任一命中、1 不是全部命中、2 一个都不命中、3 全部命中。
  - 关键词匹配：
    - 默认不区分大小写（顶层 `case_sensitive` 优先，其次 `extensions.case_sensitive`）。
    - `use_regex` 或写成 `/x/flags` 的按正则匹配，写错的正则当作不匹配。
    - `extensions.match_whole_words` 只对英文数字关键词按整词匹配，中文按包含匹配。
  - 按概率触发：`extensions.useProbability` 且 `probability` 小于 100 时抽签，`buildChatPrompt` 可以传入 `random`，测试里用固定值。
  - 按 `insertion_order` 从小到大排（SillyTavern：数字大的离结尾更近）。
- **放在哪里**：
  - 常驻、而且不是 `position: 4`（@D）的条目进不变区：`before_char`（或 `0`）放在角色描述前面，其余放在场景后面、示例对话前面。
  - 关键词触发的条目，以及所有 @D 条目（包括常驻的），合成一条 system 消息，放在聊天记录之后、`post_history_instructions` 之前。
  - 这样不管这一轮触发了什么，系统提示和聊天记录都逐字不变，缓存只在最后一段失效。
- 条目内容同样替换 `{{char}}`、`{{user}}`。

## Alternatives considered

- **照 SillyTavern 插到聊天记录里的指定深度** — 最强的理由：和卡作者在 SillyTavern 里调出来的效果一样。否掉的原因：插入点每轮都在变，从插入点往后的缓存全部失效，而缓存是开发者换掉 Tavo 的首要原因。缓存排布笔记里开发者已经同意先这么做。放在聊天记录之后，离结尾的距离和 depth 0、1 也差不多。
- **常驻的 @D 条目也进不变区** — 最强的理由：常驻内容每轮都一样，放在最前面能被缓存，省钱。否掉的原因：作者把它放在 depth 1 就是想让模型在回复前刚看过，挪到几千 token 之前，效果可能变差。放在结尾每轮多付这段的原价，万象这条约 1000 字。

## Consequences

- 2026-10-19 用开发者的万象卡在本地试（只在本地跑，卡片含成人内容，不进仓库），开场白后发一条消息：

  | 用户消息 | 系统提示 | 聊天记录之后那条 |
  |---|---|---|
  | 随机来两个 | 6828 字 | 1039 字（只有常驻的万象提醒） |
  | 推进剧情 | 6828 字 | 1581 字（加上 OOC / 推进剧情说明） |
  | 三天后 | 6828 字 | 1245 字（加上快进说明） |

  在这之前，这 3 条从来没有发给过模型。
- 测试：`lorebook.test.ts` 8 个，覆盖放置位置、排序、扫描条数、副关键词、整词和正则、概率、请求标准答案（`__golden__/lorebook-card.json`）、触发变化时系统提示不变。原来的请求标准答案没有变化，因为测试卡没有世界书。
- 还没做（代码里有 `shortcut:` 注释）：
  - 递归触发（条目内容里的关键词再触发别的条目）。
  - token 预算。
  - 分组（`group`）。
  - 导入 SillyTavern 单独导出的世界书文件，以及一段聊天挂多本世界书。
- 关键词扫描用的是消息原文（替换宏之前）。
