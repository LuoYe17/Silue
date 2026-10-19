# Agent Note: 接口配置可以存多套，API Key 按配置 id 各存各的

Status: implemented

## Problem

[OpenAI 兼容接口](2026-10-19-openai-compatible-chat.md) 第一版只有一套接口配置：地址、模型、思考深度存在数据库 `settings/provider`，API Key 存在凭据 `provider.apiKey`。开发者同一天先后用了三个接口（中转站的 Gemini、中转站的 DeepSeek、官方 DeepSeek），每换一个都要重填，之前的 API Key 被覆盖掉了。

## Decision

- 数据：`packages/core/src/llm/profiles.ts`。
  - 每套配置是 `providers` 集合里的一份文档：`name`、`baseUrl`、`model`、`thinking`、`createdAt`，会跟着同步。
  - 当前用哪套记在 `settings/app` 的 `activeProviderId`。记的那套被删了，或者从没选过，就用创建最早的那套。
  - 读出来时补齐缺的字段，不认识的思考档位按 `default`，因为同步来的数据可能是别的版本写的。
- API Key：App 端（`packages/app/src/provider.ts`）存在凭据 `provider.<配置 id>.apiKey`，不同步。删配置时连 Key 一起删。
- 界面：设置面板最上面是配置下拉框。
  - 选一套就立刻切过去用。
  - 选「＋ 新建配置」只清空表单，保存后才新建并切过去。
  - 名称不填就用模型名。
  - 删除要点两次确认。
  - 表单里没保存的修改不影响生成，生成只用已保存的当前配置。
- 旧数据搬迁：打开 App 时，如果还有旧的 `settings/provider`，就搬成一套 id 固定为 `migrated` 的配置，Key 从 `provider.apiKey` 复制过去，然后删掉旧文档和旧 Key。
  - 用固定 id 的原因：开发模式下 React 的 `StrictMode` 会把启动逻辑跑两遍，两次搬迁同时进行。第一次实现用随机 id，真 App 里搬出了两套一样的配置；改成固定 id 后，两次都写到同一套上。

## Alternatives considered

- **每段聊天或每个角色绑定一套配置** — 最强的理由：不同角色适合不同模型，切聊天时不用手动换。否掉的原因：开发者还没提这个需求；先做全局切换，以后可以在聊天或角色上加一个可选的「用哪套配置」字段，没填就用全局的。
- **搬迁时用一个进程内的锁，防止重复搬** — 最强的理由：搬出来的配置可以用普通的随机 id，和用户新建的没有区别。否掉的原因：锁只防得住同一个进程；以后有同步时，两台设备各自搬迁还是会重复。固定 id 两种情况都能防住。

## Consequences

- 2026-10-19 在真 App 里验证：
  - 把开发数据库恢复成旧格式（官方 DeepSeek 那套）后刷新，只搬出一套 `migrated`，Key 长度 35 和原来一致，凭据管理器里只剩 `provider.migrated.apiKey`。
  - 新建「中转站 DeepSeek」，保存后自动切过去，生成的回复记的模型是 `deepseek-v4.1-flash`。
  - 切回官方那套，表单显示 `https://api.deepseek.com`。
  - 新建「临时」再删除，下拉框里没了，当前配置退回第一套，它的 Key 也读不到了。
- 测试：`profiles.test.ts` 3 个（新建、排序、修改不改创建时间；当前配置的退回规则；同步来的残缺数据）。App 端的搬迁逻辑依赖 Tauri 的凭据命令，没有单元测试，只在真 App 里试过。
- 搬迁出来的配置名字是模型名（比如 `deepseek-flash`），用户可以自己改。
