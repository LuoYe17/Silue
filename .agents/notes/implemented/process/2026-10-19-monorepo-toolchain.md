# Agent Note: npm workspaces 分三个包，Biome + tsc + Vitest 做检查，依赖锁死精确版本

Status: implemented

## Problem

[技术栈笔记](../../proposed/architecture/2026-10-19-tech-stack-tauri.md)定了 app / worker / core 三块、Tauri 2 + React + TypeScript，但没定用什么工具把它们组织起来、怎么检查。开发者不看代码，代码对不对只能靠自动检查。工具越多，AI 配错的地方越多。

## Decision

### 仓库结构

| 目录 | 包名 | 内容 |
|---|---|---|
| `packages/core` | `@silue/core` | 纯 TypeScript 核心逻辑。`exports` 直接指向 `src/index.ts`，不单独编译 |
| `packages/app` | `@silue/app` | Vite + React 界面；`src-tauri/` 是 Tauri 2 的 Rust 外壳 |
| `packages/worker` | `@silue/worker` | Cloudflare Worker，`wrangler.jsonc` 配置；现在只有 `/health` |

- 用 npm workspaces 管理（根 `package.json` 的 `workspaces: ["packages/*"]`）。
- app 和 worker 通过 `"@silue/core": "*"` 依赖 core。

### core 的边界（两道检查）

- `packages/core/tsconfig.json` 的 `lib` 只有 `ES2024`，不带 DOM，`types` 为空。core 里一旦用了 `document`、`window`，类型检查就报错。
- `biome.json` 的 `overrides` 对 `packages/core/**` 开启 `noRestrictedImports`，禁止 import `@tauri-apps/*`、`react`、`react-dom`、`@silue/app`、`@silue/worker`。

2026-10-19 在 core 里临时放了一个同时 import `react`、读 `document.title` 的文件，两道检查都报了错，确认有效。

### 检查命令（根目录）

| 命令 | 做什么 |
|---|---|
| `npm run typecheck` | 每个包各跑一次 `tsc -p tsconfig.json`（TypeScript 7） |
| `npm run lint` | `biome check .`：代码格式 + lint + import 排序 |
| `npm run format` | `biome check --write .`，自动修复 |
| `npm test` | Vitest，跑 `packages/*/src/**/*.test.{ts,tsx}` |
| `npm run check:rust` | `cargo fmt --check` + `cargo clippy -- -D warnings` |
| `npm run verify-notes` | 笔记检查 |
| `npm run verify` | 依次跑 typecheck、lint、test、verify-notes |
| `npm run dev` / `npm run build` | 启动或打包 Windows 版（`tauri dev` / `tauri build`） |

- TypeScript 统一配置在 `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`，`moduleResolution: bundler`。
- Biome 配置：2 空格缩进，行宽 100，双引号。`.agents/skills` 是从外部复制进来的，不检查。

### CI（`.github/workflows/ci.yml`）

- `js` job（ubuntu）：`npm ci` → typecheck → lint → test → verify-notes。
- `rust` job（windows）：先 `vite build` 生成 `dist/`（`tauri::generate_context!` 编译时要求这个目录存在），再 `check:rust`。用 `Swatinem/rust-cache` 缓存编译结果。
- 原来单独的 `verify-notes.yml` 已经并进 `ci.yml`，然后删掉了。

### 依赖版本

- 所有依赖都用 2026-10-19 时的最新稳定版（`npm view`、crates.io、GitHub releases 查的）。
- 版本号写死，不用 `^`：`.npmrc` 里是 `save-exact=true`，Cargo 里写 `=x.y.z`。另外 `.npmrc` 设了 `engine-strict=true`，Node 版本低于 24 时直接拒绝安装。

| 依赖 | 版本 |
|---|---|
| typescript | 7.0.2 |
| vitest | 5.0.5 |
| @biomejs/biome | 2.5.15 |
| react / react-dom | 19.3.1 |
| vite | 8.3.4 |
| @vitejs/plugin-react | 6.1.2 |
| @tauri-apps/cli | 2.12.3 |
| @tauri-apps/api | 2.12.4 |
| wrangler | 4.151.2 |
| @cloudflare/workers-types | 5.20261019.1 |
| Rust 的 tauri | 2.12.4 |
| Rust 的 tauri-build | 2.7.3 |
| GitHub Action：actions/checkout | v7.0.1 |
| GitHub Action：actions/setup-node | v7.1.0 |
| GitHub Action：Swatinem/rust-cache | v2.9.2 |

npm 12 默认会拦截安装脚本，被拦下的是 `esbuild` 和 `workerd` 的 postinstall。目前保持拦截，因为这两个包的二进制文件通过可选依赖装好了，类型检查、测试、`vite build` 都不受影响。`wrangler dev` 还没有实际跑过。

### Tauri 外壳

- `identifier` 是 `io.github.luoye17.silue`。
- 窗口默认 1000×760，最小 360×480。
- 正式包的 CSP 是 `default-src 'self'`，外加 Tauri 的 IPC 和 asset 协议。开发时 `devCsp` 设为 `null`，因为 Vite 热更新需要内联脚本。
- 图标：`packages/app/app-icon.png` 是占位图（紫粉渐变的圆角方块），用 `npx tauri icon app-icon.png` 生成 `src-tauri/icons/`。Android 的图标删掉了，因为不做 Android。

## Alternatives considered

- **pnpm workspaces** — 最强的理由：安装更快，依赖隔离更严格，不会意外用到没声明的依赖。否掉的原因：多装一个工具；开发者的全局规则里用的是 `npm run`，现在的规模下 npm workspaces 够用。
- **ESLint + Prettier** — 最强的理由：生态最大，规则和插件最多，AI 最熟。否掉的原因：两个工具、好几个配置文件，还要处理它们之间的冲突；Biome 一个工具就包括格式、lint 和 import 排序，`noRestrictedImports` 也能守住 core 的边界。
- **TypeScript 6（JS 版的 tsc）** — 最强的理由：TS 7 是 Go 重写的版本，有的工具依赖 TS 的 JS API，可能不兼容。否掉的原因：开发者要求用最新稳定版；Biome、Vitest、Vite 都不依赖 TS 的 JS API，`tsc` 只用来做类型检查，TS 7 能正常运行。
- **用 tsx 跑笔记脚本** — 最强的理由：技能文档里写的就是 `npx tsx`。否掉的原因：Node 24 能直接运行 `.ts` 文件，少装一个依赖。

## Consequences

- 收益：一条 `npm run verify` 就能在本地跑完全部 JS 检查；CI 会挡住类型错误、格式问题、失败的测试和格式不对的笔记；core 的边界由机器检查，不靠人记。
- 代价：版本写死以后不会自动升级，要定期手动升级。TS 7 比较新，以后引入依赖 TS JS API 的工具（比如 typescript-eslint）时可能不兼容。
- 「不通过就不能合并」需要在 GitHub 上给 `main` 开分支保护，这一步还没做。
- 2026-10-19 本地结果：
  - `npm run typecheck`、`npm run lint`、`npm test`（2 个文件，3 个测试）、`npm run verify-notes` 全部通过。
  - `npm run check:rust` 通过（首次编译 2 分 14 秒）。
