# DataForge 依赖规划（DataGrip 对齐版）

本文记录运行时基线、现有依赖、为 DataGrip 对齐**计划引入**的依赖及其取舍。
版本数字以仓库 `package.json` 为准；计划项在真正安装前不写入依赖表。

## 1. 运行时基线

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `^22.18.0 \|\| >=24.12.0` | 与 VS Code 1.115+ 内置 Node 对齐 |
| npm | 11+（workspaces） | 根目录统一安装，npm 11 默认阻止 install script |
| VS Code | `^1.115.0` | `@types/vscode` 固定同版本 |
| PostgreSQL | 12+ | 18 已实测 |
| MySQL | 8.0+（MariaDB 兼容） | 8.4 已实测 |
| SSH（规划） | OpenSSH 兼容服务端 | 仅端口转发，不做 SFTP |

## 2. 现有依赖

### extension（运行时）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `pg` | ^8.23.1 | PostgreSQL 驱动 |
| `pg-cursor` | ^2.22.1 | 流式导出（无内置类型，仓库自带 `src/types/pg-cursor.d.ts`） |
| `mysql2` | ^3.24.6 | MySQL 驱动（纯 JS，promise API） |
| `zod` | ^4.6.7 | 协议与持久化校验 |
| `sql-formatter` | ^15.9.0 | SQL 格式化（宿主执行，避免 Webview 引入解析器） |

### extension（开发）

`typescript ~6.0.0`、`esbuild ^0.28.2`、`@types/vscode`（与 `engines.vscode` 同版本）、
`@types/pg`、`@types/node`、`vitest ^4.1.11`、`@vscode/vsce ^4.1.0`。

### webview

运行时：`vue ^3.5.42`、`pinia ^4.0.3`、`ag-grid-community`/`ag-grid-vue3 36.3.0`、
`lucide-vue-next ^1.0.0`。
开发：`vite ^8.2.2`、`@tailwindcss/vite`、`tailwindcss ^4.3.4`、`vue-tsc`、`jsdom`、
`vitest`、`playwright`、`npm-run-all2`。

### 根

`oxlint`、`eslint ^10`、`eslint-plugin-vue`/`oxlint`/`vitest`/`playwright`、
`typescript`、`jiti`（eslint 配置 TS 入口）。

## 3. 计划引入

| 包 | 目标版本 | 用于 | 选择理由 / 风险 |
| --- | --- | --- | --- |
| `ssh2` | ^1.16 | SSH 隧道（G 阶段） | 纯 JS 可用；可选原生 `cpu-features` 构建失败不影响使用。替代方案：调用系统 `ssh` 子进程（不支持密钥管理、跨平台差） |
| `@types/ssh2` | ^1.15 | 同上 | DefinitelyTyped 维护 |
| `csv-parse` | ^6 | 导入解析（E 阶段） | 流式、容错、可处理引号/换行；不引入完整 ETL |

新增依赖的唯一目的是**新能力**，且必须满足：纯 JS 可打包、无运行期二进制依赖、
许可证 MIT/Apache-2.0、维护活跃。

## 4. 评估后不引入

| 候选 | 结论 |
| --- | --- |
| `libpg-query` / `pg-query-parser` | 原生绑定，无法在扩展内稳定分发；SQL 校验改用“只读语句 + EXPLAIN 预检 + 服务端报错” |
| `node-sql-parser` | 对 PostgreSQL/MySQL 方言覆盖不足，误判成本高于收益 |
| `better-sqlite3` / `node:sqlite` | 原生/实验级依赖；SQLite 支持推迟到 D7 再评估（可用 `sql.js` WASM） |
| `monaco-editor` | 与 VS Code 编辑器重复；违反“不重写编辑器”约束 |
| ORM / 查询构建器（Prisma、Knex 等） | 隐藏 SQL、难以做方言差异与流式控制 |
| `tarn`/连接池库 | `pg`/`mysql2` 自带 pool，够用 |

## 5. 版本与安装策略

- 统一在根目录 `npm install`，禁止在子包内单独提交 lockfile。
- npm 11 默认阻止 install script：需要 `npm install-scripts approve esbuild`、
  `approve @vscode/vsce-sign`，随后 `npm rebuild esbuild`；CI 通过根 `package.json`
  的 `allowScripts` 白名单恢复。
- 工作区包改名/改版本后必须 `npm install --package-lock-only`，否则 `npm ci` 失败
  （0.1.2 已踩过）。
- 引擎要求写入 `engines`，不满足时安装阶段即失败，避免运行期才发现。
- 每季度执行 `npm audit --omit=dev` 与 `npm outdated`，高危项优先升级驱动与 `zod`。

## 6. 体积与性能预算

| 产物 | 预算 | 现状（0.1.3） |
| --- | --- | --- |
| `extension/dist/extension.js` | ≤5 MB | ~1.9 MB（含 pg + mysql2） |
| Webview `index.js` | ≤1.5 MB（gzip ≤400 KB） | ~1.28 MB（AG Grid 占大头） |
| `dataforge.vsix` | ≤2 MB | ~975 KB |

超标处理顺序：按驱动懒加载 → Webview 路由级 code split → AG Grid 独立 chunk →
剔除未用模块。新增依赖前先估算打包增量。

## 7. 安全与供应链

- 密码/私钥/口令一律 SecretStorage；日志统一经 `redactSecrets`。
- 只从 npm 官方源安装；锁文件提交；CI 用 `npm ci --ignore-scripts` 之外的受控白名单。
- 新依赖需检查：最近发布、周下载量、是否含 postinstall 脚本、许可协议。
- SSH 隧道仅绑定 `127.0.0.1`，断开连接即关闭；不在日志中输出主机密钥内容。
