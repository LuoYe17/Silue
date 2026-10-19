# Agent Note: 用户人设先做全局一份，名字替换 {{user}}，描述放在角色描述前面

Status: implemented

## Problem

拼提示词时 `{{user}}` 一直取这段聊天里最后一条用户消息的名字，新建的聊天里就是「你」；用户没法告诉模型自己扮演的是谁（[第一版范围](../../proposed/feature/2026-10-19-v1-scope.md) 里列了用户人设）。

## Decision

- 代码在 `packages/core/src/chat/persona.ts`：`loadPersona`、`savePersona`。人设只有名字和描述两个字段，存在 `settings/app` 文档的 `personaName`、`personaDescription` 里，和 `activeProviderId` 同一份文档、按字段合并，互不覆盖；跟着同步。
- `buildChatPrompt` 多了 `persona` 参数（描述）。放在系统提示里「世界书 before」之后、角色描述之前，照 SillyTavern 的默认顺序（2026-10-19 查的 release 分支 `public/scripts/PromptManager.js` 的 `promptManagerDefaultPromptOrder`：main、worldInfoBefore、personaDescription、charDescription……）。描述里的宏照样替换。人设属于缓存排布里的第 1 段不变区（[缓存排布](../../proposed/feature/2026-10-19-prompt-cache-layout.md)），只有用户改人设时缓存才失效。
- `{{user}}` 的名字：人设填了名字就用它；没填时沿用这段聊天里最后一条用户消息的名字（导入的 ST 聊天带名字），再没有就是「你」。新发的用户消息也存这个名字。显示时的宏替换用同一个名字。
- 界面：侧栏「模型设置」下面加「我的人设」，名字、描述、保存。

## Alternatives considered

- **像 SillyTavern 那样多个人设，按角色或聊天锁定** — 最强的理由：同一个用户在不同的卡里扮演不同的人，ST 用户都习惯这么用。否掉的原因：这一版先让人设能用起来；多个人设可以照 [多套接口配置](2026-10-19-provider-profiles.md) 的写法改成集合，存储字段到时候迁移。代码里有 `shortcut:` 注释。
- **人设描述放在聊天记录之后** — 最强的理由：离结尾近，模型更记得住。否掉的原因：人设几乎不变，放进不变区能被缓存；ST 默认也放在前面。

## Consequences

- 2026-10-19 在真 App 里验证（开发模式）：
  - 填名字「测试名」和描述，保存后刷新页面还在，首尾空白被去掉。
  - 在万象卡的一段聊天里发「（场外）我是谁？」：新消息的发送者显示为「测试名」，官方 DeepSeek 回复「你是测试名……」。
  - 用存储里的人设在页面里拼一次提示词：描述出现在默认系统提示之后、万象卡描述之前。
  - 验证完把人设清空了。
  - 没有截到 App 实际发出的请求体（改写 `__TAURI_INTERNALS__.invoke` 没截到 HTTP 插件的调用），描述是否真的发出去，靠的是上面在页面里复现和单元测试。
- 测试：`persona.test.ts` 1 个（默认空、去空白、和接口配置字段互不覆盖），`chat-prompt.test.ts` 加 1 个（位置和宏）。已有的标准答案没有变化，因为没有人设时不加任何内容。
