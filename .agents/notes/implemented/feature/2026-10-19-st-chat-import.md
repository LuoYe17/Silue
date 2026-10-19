# Agent Note: ST/Tavo 聊天记录先读成线性消息列表，转消息树留给存储层

Status: implemented

## Problem

开发者要把 Tavo 里正在玩的长线 RP 搬到 Silue 来（[第一版范围](../../proposed/feature/2026-10-19-v1-scope.md)）。Tavo 导出的是 SillyTavern 的 `.jsonl` 格式，开发者给过一份真实导出文件 `Tavo_万象_1HNyS.jsonl`，有 203 条消息：

- 第一行是头信息：`user_name`、`character_name`、`create_date`、`chat_metadata`
- 之后每行一条消息：`name`、`is_user`、`is_system`、`send_date`、`mes`、`original_avatar`、`extra`
- 没有左右滑动的备选回复

ST 自己导出的消息还可能带 `swipes` 和 `swipe_id`。

Silue 的聊天存成一棵消息树（[同步](../../proposed/architecture/2026-10-19-sync-e2e-cloudflare.md)），写这个导入时存储层还没写。

## Decision

- `packages/core/src/chat/import-st.ts` 的 `importStChat(text)` 只负责把文件读成 `ImportedStChat`，不涉及数据库：
  - 头信息：`userName`、`characterName`、`createdAt`
  - `metadata`：`chat_metadata` 原样保留，比如万象记忆插件写在 `variables.wanxiang` 里的存档
  - `messages`：按文件顺序排列，每条有：
    - `role`：`user`、`assistant` 或 `system`（`is_system` 优先于 `is_user`）
    - `name`
    - `swipes`：所有备选回复，至少一条；没有 `swipes` 字段时就是 `[mes]`
    - `swipeIndex`：`swipe_id` 越界时用 0
    - `sentAt`
    - `raw`：整行原始数据
- **日期**：都按本地时间解析成毫秒数，解析不了就是 `undefined`，原值留在 `raw` 里。支持这几种写法：
  - 毫秒数
  - ISO 字符串
  - `October 19, 2026 10:15am`
  - `2026-10-19@10h13m58s`：ST 头信息里的 `create_date` 用这种写法，Tavo 导出的文件也是
- **容错**：去掉 BOM，兼容 CRLF，跳过空行。
- **错误**：抛 `ChatImportError`，带 `code`（`empty`、`invalid_json`、`invalid_header`、`invalid_message`）和出错的行号。如果第一行带 `mes` 字段，说明文件缺了头信息，报 `invalid_header`。
- BOM 在代码里一律用 `String.fromCharCode(0xfeff)` 生成，不写字面字符。原因：本次提交时，`biome check --write` 把源码里的 `﻿` 转义改成了看不见的字面 BOM 字符。具体是哪条规则改的没查出来，用码点写可以避开。

## Alternatives considered

- **导入时直接生成消息树** — 最强的理由：一步到位，少一种中间结构。否掉的原因：消息树的结构和存储层的设计（id、同步字段）还没定；先输出线性列表，存储层定下来以后再转换，这部分代码不用跟着改。

## Consequences

- 收益：`importStChat` 是纯函数，不依赖数据库和界面，测试简单。2026-10-19 用开发者的真实文件试过：
  - 203 条消息全部读出：101 条用户消息，102 条 AI 回复
  - 每条消息的日期都能解析
  - `createdAt` 解析为本地时间 2026-10-19 10:13:58
  - `metadata` 里有 `variables`

  这个文件含成人内容，没有放进仓库。
- 代价：
  - 文件要整个读进内存再按行拆分。几百条消息、几 MB 的文件没有问题，几百 MB 的大文件会占很多内存。
  - 「线性列表 → 消息树」的转换另外写在存储层的 `importStChatToStore` 里，见 [本地存储](../architecture/2026-10-19-doc-store.md)。
- 测试：`packages/core/src/chat/import-st.test.ts`，共 8 个，覆盖：
  - Tavo 的导出格式
  - ST 的多条备选回复，`swipe_id` 越界
  - 系统消息、BOM、CRLF、空行
  - 两种日期写法，解析不了的日期
  - 四种错误
