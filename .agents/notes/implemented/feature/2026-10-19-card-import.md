# Agent Note: 角色卡导入统一转成 V3，保留不认识的字段，错误只给代码不给文字

Status: implemented

## Problem

[第一版范围](../../proposed/feature/2026-10-19-v1-scope.md)要求导入 V1、V2、V3 三种规格的卡，格式有 JSON、PNG、CHARX 三种。卡片是从网上下载的，质量参差不齐：缺字段、字段是 `null`、带着各家前端自己加的字段都很常见。比如开发者的万象卡，世界书条目里带了 `strategy`、`injectionDepth` 这类 Tavo 自己的字段。

另外，界面文字必须走翻译文件，core 里抛出的错误不能直接写中文提示。

## Decision

代码在 `packages/core/src/card/`：`schema.ts` 定义结构，`import.ts` 负责导入。

### 内部结构

- 所有卡都转成 V3 结构 `CharacterCardV3`（`spec: "chara_card_v3"`、`spec_version: "3.0"`、`data`）。V1 和 V2 在导入时升级，原来的版本记在 `sourceVersion` 里。
- 规格：https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md 。V3 是 V2 的超集，V2 升级时补上 `group_only_greetings: []`，世界书条目补上 `use_regex: false`。
- **字段补齐**：
  - 必填的文本缺了或是 `null`，补 `""`；必填的数组补 `[]`；`extensions` 补 `{}`。
  - 世界书条目的 `enabled` 默认 `true`，`insertion_order` 默认 `0`。
  - 可选字段是 `null` 时，当作没有这个字段。
- **硬要求**：`name` 必须是字符串，否则拒绝导入。没有 `spec` 的 JSON 按 V1 处理时，还必须有 `first_mes` 字段（V1 规格里必填）：2026-10-19 在真 App 里试导入 ST 预设文件 `万象_预设.json`，它只有 `name` 没有角色字段，原来被当成 V1 卡导入了。
- **不认识的字段全部保留**：用 zod 的 `looseObject`。规格允许这样做，导出时可以原样带上；Tavo、ST 的私有字段也不会丢。
- 世界书条目的 `position`：规格写的是字符串，但兼容数字，因为 SillyTavern 导出的卡里见过数字。

### 三种格式

| 格式 | 怎么认 | 怎么读 |
|---|---|---|
| PNG | 文件头 `89 50 4E 47 0D 0A 1A 0A` | 找 tEXt 块，`ccv3` 优先，没有再用 `chara`（规格要求两者都有时用 `ccv3`）；内容是 base64 编码的 UTF-8 JSON。原图放进 `image`，规格里的 `ccdefault:` 图标就指它 |
| CHARX | 文件头 `PK 03 04`（zip） | 根目录的 `card.json` 是卡片；其他文件放进 `files`，键是 zip 内的路径，对应卡片里的 `embeded://<路径>` |
| JSON | 去掉 BOM 和开头空白后以 `{` 开头 | 直接解析 |

- PNG 只检查结构完整（每个块的长度不越界、有 IEND），不校验 CRC。
- CHARX 是不可信的 zip。按 zip 头里声明的解压后大小设上限：单个文件 64 MiB，全部文件加起来 256 MiB，超过就报 `charx_too_large`，防止压缩炸弹。

### 错误

导入失败时抛 `CardImportError`，包含两部分：

- `code`：给界面用，界面拿它去翻译文件里找提示文字。取值有 `unknown_format`、`invalid_json`、`invalid_card`、`png_corrupt`、`png_no_card`、`charx_corrupt`、`charx_no_card_json`、`charx_too_large`。
- `detail`：只写进日志，不给用户看。

### 新增依赖（core）

- `zod` 4.6.7：校验卡片结构。后面导入预设、正则、聊天记录也要用。
- `fflate` 0.8.3：解 zip、做 UTF-8 解码。纯 JavaScript，没有其他依赖，浏览器、Node 和 Workers 都能跑。

core 的 tsconfig 不带 DOM 类型，用到的 `atob` / `btoa` 在 `src/web-globals.d.ts` 里单独声明。只有浏览器、WebView、Node 24、Workers 都有的全局函数才能加进这个文件。

## Alternatives considered

- **按原始版本分别存（V1、V2、V3 各一套结构）** — 最强的理由：导入的内容原封不动，导出时不会有任何变化。否掉的原因：之后拼提示词、编辑卡片、同步，每一处都得分三种情况处理。V3 是 V2 的超集，升级不会丢信息，不认识的字段也保留了下来。
- **严格校验，缺字段就拒绝导入** — 最强的理由：数据干净，后面的代码不用考虑缺字段的情况。否掉的原因：网上的卡大量缺字段或者是 `null`，严格校验会让很多卡导不进来。补齐默认值以后，后面的代码同样拿到的是完整结构。
- **不用 zod，手写校验** — 最强的理由：少一个依赖。否掉的原因：卡片、世界书、预设、正则、聊天记录都要校验，手写的代码量大，也容易漏。
- **不用 fflate，用 `DecompressionStream` 解 zip** — 最强的理由：所有平台都内置，不用加依赖。否掉的原因：它只能解压数据流，读 zip 的目录结构还得自己写；而且 core 不带 DOM 类型，还要额外声明。

## Consequences

- 收益：
  - 后面的代码只需要处理一种结构。
  - 开发者的真实卡片都能导入。2026-10-19 在本地试过：
    - `万象_v2.json` 识别为 V3，带 3 条世界书条目，`extensions.regex_scripts` 完整保留。
    - `_char_backup.json`（Tavo MCP 返回的、没有外壳的卡片数据）按 V1 导入成功。

    这两个文件含成人内容，没有放进仓库。
- 代价：
  - 导出时会多出补齐的空字段，和原文件不完全一样。
  - 补成 `""` 和原来就是 `""` 的字段，区分不出来。
- 还没做：
  - PNG 的 `chara-ext-asset_:` 资源块（规格建议新应用不要实现）。
  - 导出成 PNG 或 CHARX。
  - ST 单独导出的世界书文件（格式和卡片里的 `character_book` 不同）。
- 测试：`packages/core/src/card/import.test.ts`，共 14 个，覆盖：
  - V1、V2 升级
  - 没有 `spec` 也没有 `first_mes` 的 JSON（ST 预设）
  - `null` 字段
  - 缺名字
  - BOM
  - PNG 只有 `chara`、两种块都有、没有卡片数据、截断
  - CHARX 正常、缺 `card.json`
  - 不认识的文件
  - 读取全部 tEXt 块
