# Agent Note: 公开仓库从第一行开始，GitHub Actions 把关并负责出包

Status: proposed

## Problem

开发者不懂代码，代码对不对只能靠自动检查。iOS 包只能在云端 Mac 上出（见 [技术栈](../architecture/2026-10-19-tech-stack-tauri.md)）。项目要开源，协议是 AGPL-3.0。

## Proposal

- **仓库**：现在就在 GitHub 建公开仓库 `Silue`，协议 AGPL-3.0（`LICENSE` 是从 `gh api licenses/agpl-3.0` 取的官方原文）。`package.json` 里写 `"license": "AGPL-3.0-only"`。
- **每次提交都检查**：类型检查、代码格式、`npm test`、`npm run verify-notes`。任何一项不通过就不能合并到 `main`。
- **笔记**：
  - 重要改动按 `.agents/skills/write-notes-like-deepseek/` 的规范写进 `.agents/notes/`。
  - `npm run verify-notes` 用 Node 24 直接运行技能里的 `.ts` 脚本，不需要 tsx。
  - CI 配置在 `.github/workflows/ci.yml`，每次提交都检查的那部分已经落地，见 [工具链](../../implemented/process/2026-10-19-monorepo-toolchain.md)。
- **发版**：
  - 版本号用「主版本.次版本.修订号」（比如 1.2.0）。
  - 打 tag 时，GitHub Actions 出 Windows 安装包和不签名的 iOS ipa，自动生成更新说明，一起放进 GitHub Releases。
  - Windows 版在 App 内自动更新。
  - iOS 的 ipa 由开发者下载后自签安装。
- **Windows 代码签名**：第一版不签，安装时会出现「未知发布者」的警告。以后可以申请开源项目的免费签名，比如 SignPath 的开源计划（申请条件没查）。
- **发版前**：手动过一遍 iOS 真机清单（见 [标准答案测试](../testing/2026-10-19-golden-prompt-tests.md)）。

## Alternatives considered

- **先私有开发，做完再公开** — 最强的理由：半成品不会被人看到，也不怕早期设计被人评头论足。否掉的原因：私有仓库用 macOS 机器超出额度后每分钟 $0.062，而每次出 iOS 包都要用；AGPL 本来就要求公开源码，晚公开没有好处。
- **第一版就买 Windows 代码签名证书** — 最强的理由：安装时没有警告，看起来更正规。否掉的原因：证书要花钱（价格没查），第一版只有开发者自己用，点一下就过去了。

## Acceptance criteria

- 往 `main` 发一个类型错误、测试失败或者笔记格式不对的 PR，CI 会报红，不能合并。
- 推一个 tag，Releases 页面上会出现 Windows 安装包和 ipa。
- 已安装的 Windows 版能检测到新版本并自动更新。

## Risks

- **macOS 机器是否免费**：没核实公开仓库的 macOS 机器是否免费。如果不免费，就要控制出 iOS 包的次数，只在打 tag 时出。
- **技能脚本放在公开仓库里**：`.agents/skills/write-notes-like-deepseek/` 是从开发者本机的技能目录复制过来的，方法来自 DeepSeek Harness，目录里没有许可证文件。开发者 2026-10-19 确认可以放进公开仓库。
