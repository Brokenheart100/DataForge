# DataForge 依赖

> 版本取自当前 `package.json`（2026-11）。`^` 表示允许次版本升级，`~` 只允许补丁升级；所有依赖都已安装并验证可构建。

## 1. 运行时约束

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | `^22.18.0 \|\| >=24.12.0` | 根 `package.json` 的 `engines`；本机实测 v24.21.0 |
| npm | 11.x | 需要 workspaces；npm 11 默认阻止 install scripts，见第 7 节 |
| VS Code | `^1.115.0` | `extension/package.json` 的 `engines.vscode`；本机 1.145.0 可用 |
| PostgreSQL | 12+（实测 17） | 用到 `pg_terminate_backend`、`relkind`、`format_type` 等稳定接口 |

## 2. Extension Host

### 2.1 运行时依赖（会打进 `dist/extension.js`）

| 包 | 版本 | 用途 | 位置 |
| --- | --- | --- | --- |
| `pg` | `^8.23.1` | PostgreSQL 连接池与查询；`rowMode: 'array'` 保证列顺序稳定 | `extension/package.json` |
| `pg-cursor` | `^2.22.1` | CSV 导出的服务端游标；CommonJS、无自带类型，仓库内有 `src/types/pg-cursor.d.ts` 最小声明 | 同上 |
| `sql-formatter` | `^15.9.0` | Phase 3 格式化；只在宿主侧调用（`language: 'postgresql'`），格式化结果通过 `WorkspaceEdit` 回填 | 同上 |
| `zod` | `^4.6.7` | 校验 webview 消息与 `globalState` 中的持久化数据 | 同上 |

`pg-native` 在 esbuild 中标记为 external，未安装，走纯 JS 实现。

### 2.2 开发依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `typescript` | `~6.0.0` | 类型检查（`tsc --noEmit`）；TS 6 已弃用 `baseUrl`，故 `paths` 用相对路径 |
| `esbuild` | `^0.28.2` | 打包为 CommonJS、target node22、外部化 `vscode` |
| `@types/node` | `^24.13.4` | Node 类型 |
| `@types/vscode` | `1.115.0`（**精确版本**） | 与 `engines.vscode` 对齐；升级 API 用最低支持版本，避免用上旧版 VS Code 不存在的接口 |
| `@types/pg` | `^8.23.1` | `pg` 类型 |
| `vitest` | `^4.1.11` | 宿主单测与集成测试（`vitest.config.mts` 把 `vscode` 别名指向 mock） |
| `@vscode/vsce` | `^4.1.0` | 生成 VSIX；`--no-dependencies` 因为已 bundle |

## 3. Webview

### 3.1 运行时依赖（会进 Vite 产物）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `vue` | `^3.5.42` | 视图层，全部 SFC 使用 `<script setup lang="ts">` |
| `pinia` | `^4.0.3` | 单一 store（`useWorkbenchStore`），不引入额外状态库 |
| `tailwindcss` | `^4.3.4` | 样式引擎；设计令牌写在 `src/assets/main.css` 的 `@theme` |
| `@tailwindcss/vite` | `^4.3.4` | Tailwind v4 的 Vite 插件（无 PostCSS 配置） |
| `lucide-vue-next` | `^1.0.0` | 图标；只用命名导出，已核对存在性 |
| `ag-grid-community` / `ag-grid-vue3` | `36.3.0` | Phase 2 数据网格；只用 Community 能力（编辑、排序、客户端分页靠 SQL 的 limit/offset），Theming API `themeQuartz.withParams` 贴合令牌 |

> 备注：`tailwindcss` 与 `@tailwindcss/vite` 只需参与构建，放在 `dependencies` 不影响产物（Vite 会把 CSS 抽成静态文件），后续可迁到 `devDependencies` 以明确语义。

### 3.2 开发依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `vite` | `^8.2.2` | 构建；输出目录直接指向 `../extension/dist/webview` |
| `@vitejs/plugin-vue` | `^6.0.8` | SFC 编译 |
| `vue-tsc` | `^3.3.11` | `.vue` 类型检查（`vue-tsc --build`） |
| `vitest` | `^4.1.11` | webview 单测（`jsdom` 环境） |
| `jsdom` / `@types/jsdom` | `^30.0.1` / `^30.0.0` | 浏览器环境模拟 |
| `@vue/test-utils` | `^2.5.0` | 组件测试预留，当前未使用 |
| `@playwright/test` | `^1.63.0` | e2e 预留（脚手架用例尚未替换） |
| `npm-run-all2` | `^9.0.3` | `build` 并行跑 `type-check` + `vite build` |
| `@vue/tsconfig` / `@tsconfig/node24` | `^0.9.1` / `^24.0.5` | tsconfig 基线 |
| `vite-plugin-vue-devtools` | `^8.2.1` | 已从 `vite.config.ts` 移除，属未使用依赖，可删 |

## 4. 根工作区工具链

根依赖只服务于「跨两个 workspace 的静态检查」，不参与运行：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `typescript` | `~6.0.0` | 两个 workspace 共用 |
| `oxlint` / `eslint` | `~1.82.0` / `^10.10.0` | 双 linter：oxlint 先跑（快），ESLint 补类型感知与 Vue 规则 |
| `eslint-plugin-oxlint` | `~1.82.0` | 关掉与 oxlint 重叠的规则，避免互相打架 |
| `eslint-plugin-vue` | `~10.11.0` | `flat/essential` + 推荐规则 |
| `@vue/eslint-config-typescript` | `^14.9.0` | Vue + TS 的解析器与规则 |
| `vue-eslint-parser` | `^10.4.1` | `.vue` 解析 |
| `eslint-plugin-playwright` | `^2.12.0` | 仅作用于 `webview/e2e/**` |
| `@vitest/eslint-plugin` | `^1.6.27` | 仅作用于 `**/__tests__/*` |
| `jiti` | `^2.7.0` | 让 ESLint 能直接加载 `eslint.config.ts` |

## 5. 版本策略

- **`@types/vscode` 固定精确版本**：它必须等于 `engines.vscode` 的下限，否则会写出运行时不存在的新 API。升级时两处一起改，并在真机验证。
- **TypeScript 6**：脚手架指定 `~6.0.0`。它移除了 `baseUrl`，因此 `extension/tsconfig.json` 只用 `paths` 的相对映射（`@shared/* → ../shared/*`）。
- **Zod 4**：`z.enum(REQUEST_TYPES)`、`.trim()`、`.partial()`、issue `path` 均按 v4 行为实现。
- **不新增依赖的默认立场**：能用 VS Code 内置能力（`SecretStorage`、`OutputChannel`、`TreeView`、语言 API）就不引入库；UI 库调研见下节。

## 6. 选型记录

### UI 库：全部不采用，用 Tailwind v4 令牌自建

| 候选 | 结论 |
| --- | --- |
| `brutxui` | npm 404，不存在 |
| `brutx-ui@0.3.0` | 实为 **React** 组件库（peer 依赖 react / radix），Vue 不可用 |
| `neobrutalism-vue@1.0.0` | 单人维护，无 Tailwind/生态证据，不承担组件库级别的风险 |
| `daisyUI` | 维护良好，但等于引入第二套组件样式，与「新粗野主义 + 少量令牌」目标重复 |

结论：新粗野主义的外观（2px 墨色描边、4px 硬阴影、黄/紫主色）本质上就是十几个 CSS 变量 + 四个组件类，写在 `webview/src/assets/main.css` 里，约 50 行，且天然适配 VS Code 明暗主题。

### 数据网格：AG Grid Community（Phase 2 已引入）

Phase 1 的只读结果继续用自写的轻量表格（前端按 200 行分页渲染）；Phase 2 的编辑网格用 AG Grid Community 36.3.0（`ag-grid-community` + `ag-grid-vue3`）：

- 需要 `ModuleRegistry.registerModules([AllCommunityModule])`；主题用 `themeQuartz.withParams(...)` 而不是手写 `--ag-*` 变量。
- **服务端行模型（SSRM）属 Enterprise**，因此分页靠 SQL `limit/offset` + `count(*)` 自己做，排序通过 `onSortChanged` 回传宿主执行 `order by`。
- AG Grid 会测量容器高度：组件根必须处于有确定高度的 flex 链上（`.df-grid { display:flex; flex-direction:column }`、`.df-grid-ag { flex:1; min-height:0 }`、`.ag-root-wrapper { height:100% }`），否则根节点量到 2px，表格"存在但不渲染"。
- 代价：webview 产物从约 100 KB 增到约 1.33 MB（gzip 380 KB），尚未做代码分割。

### 其他候选（已验证存在，暂不引入）

| 包 | 版本 | 计划 |
| --- | --- | --- |
| `sql-formatter` | 15.9.0 | Phase 3「格式化 SQL」，在宿主侧执行后回填编辑器 |
| `pg-cursor` | 2.22.1 | Phase 2 CSV 导出，宿主侧流式读取，避免整表进内存 |
| `@vscode/test-cli` / `@vscode/test-electron` | 0.0.15 / 3.1.0 | 真正需要「在 VS Code 内跑集成测试」时再接入；当前用 mock 覆盖激活路径 |

## 7. 安装与构建注意

1. **npm 11 默认不跑 install scripts**。首次 `npm install` 后会提示 `esbuild`、`@vscode/vsce-sign` 未执行脚本；必须：
   ```bash
   npm install-scripts approve esbuild
   npm install-scripts approve @vscode/vsce-sign
   npm rebuild esbuild
   node -e "console.log(require('esbuild').version)"   # 0.28.2
   ```
   否则 esbuild 二进制缺失，构建报错。根 `package.json` 已记录 `allowScripts`，重装后仍可能需要重新执行。
2. **workspaces 提升**：`node_modules` 在根目录，`extension/` 与 `webview/` 内只见软链。`vsce package --no-dependencies` 依赖 bundle 产物，不读取 workspace 的远端依赖。
3. **esbuild 是扩展的打包器，不是 VS Code 的**：`vscode` 被声明为 external，运行时由宿主注入。
4. **Vite dev server 只监听 IPv6 `localhost`**：浏览器访问用 `http://localhost:5174`，`127.0.0.1:5174` 会连接失败。
5. **Vite 产物文件名固定**：`assets/index.js` / `assets/index.css`，因为 HTML 由宿主生成（见架构文档）。改动 `vite.config.ts` 的 `rollupOptions.output` 时必须同步 `workbench-panel.ts`。
6. **Windows 文件锁**：dev server 运行中修改 `main.css` 可能触发 `ReplaceFileW EIO`；先停 server 再改。

## 8. 待清理与风险

| 项 | 状态 | 建议 |
| --- | --- | --- |
| `vite-plugin-vue-devtools` | 已在配置中移除，依赖仍在 | 删除，减少安装体积 |
| `tailwindcss` / `@tailwindcss/vite` 位置 | 在 `dependencies` | 迁到 `devDependencies`（只参与构建） |
| `@vue/test-utils`、Playwright | 已安装未使用 | 保留到 Phase 2 组件测试/真正的 e2e |
| `npm audit` | 安装时报 “5 moderate severity vulnerabilities” | 未审计；多为 dev 工具链传递依赖，发布前跑一次 `npm audit --omit=dev` 确认生产依赖干净 |
| `@types/vscode` 升级 | 固定 1.115.0 | 每次随 `engines.vscode` 一起升，避免用新 API 掉兼容 |
| 发布元数据 | `publisher: "dataforge"` 为占位 | 发布前改真实 publisher，补 `repository` / `icon` / `categories` |
