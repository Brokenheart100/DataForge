# DataForge 计划

> 以 Phase 1 已交付为前提的增量计划。每阶段都有可勾选的 Todo List，完成后按批次勾掉，不做「大爆炸式」提交。
> 约束回顾：单批最多改动 3 个文件；所有写操作参数化；标识符只来自元数据并经引号转义；危险操作必须确认。

## 1. 进度总览

| 阶段 | 范围 | 状态 | Todo 完成度 |
| --- | --- | --- | --- |
| Phase 1 | 连接、浏览、查询、结果展示 | ✅ 已交付 | 21 / 21 |
| Phase 2 | 数据编辑、事务、分页/排序/筛选、CSV 导出 | ✅ 实现完成 | 35 / 35（DoD 7 / 7） |
| Phase 3 | 补全、格式化、历史、诊断、EXPLAIN、显式事务 | ✅ 实现完成 | 12 / 12 |
| Phase 4 | 多驱动（MySQL 已落地，SQLite / SQL Server 未开始） | ✅ 实现完成 | 6 / 6 |
| 工程化 | 跨阶段待办（CI、发布、清理） | 🟡 进行中 | 3 / 11 |

图例：`[x]` 已完成 · `[ ]` 待办 · 每批完成即勾选并跑一次 `type-check` + `test:unit`。

## 2. 工作原则

1. **先端口后实现**：新能力先补 `domain` / `application` 的端口与类型，再写 `infrastructure`，最后接 `presentation` / webview。
2. **每批 ≤ 3 个文件**，按依赖顺序拆分；每批结束跑 `type-check` + `test:unit` + `lint`。
3. **不提前抽象**：只有第二种数据库、第二种编辑器形态出现时才引入对应泛化。
4. **不用伪代码交付**：每个里程碑都必须可构建、可运行、有测试。
5. **验证门槛**：`npm run build && npm run type-check && npm run test:unit && npm run lint && npm run package` 全绿才算完成。

## 3. Phase 1（已完成）

| 交付项 | 位置 | 说明 |
| --- | --- | --- |
| 激活与命令 | `extension/src/extension.ts` | 6 个命令、状态栏、TreeView、Disposable 统一注册 |
| 连接管理 | `application/connection-service.ts` | CRUD、测试、连接/断开、名称去重、密码入 SecretStorage |
| 查询执行 | `application/query-service.ts` | 只读守卫、`maxRows` 钳制到 10 000、取消登记 |
| 元数据 | `application/schema-service.ts` | schema/表/视图/列 + 主键，Promise 缓存按连接失效 |
| 协议与校验 | `shared/protocol.ts`、`presentation/message-router.ts` | 信封 + payload 双层 Zod，唯一 requestId |
| 工作台 | `presentation/workbench-panel.ts` | 宿主生成 HTML，CSP nonce，单例面板 |
| Webview | `webview/src/{App.vue,stores/workbench.ts,lib/host.ts}` | 连接卡片、SQL 编辑器、结果表格、连接对话框 |

### 3.1 Todo List

**基础骨架（4）**

- [x] 根工作区拆分 `extension/` + `webview/`，依赖与 tsconfig 隔离
- [x] `shared/protocol.ts`：请求 / 响应 / 事件三类消息与 `REQUEST_TYPES`
- [x] `domain` 层：`ConnectionProfile` / `ConnectionConfig` / `ConnectionStatus`、错误码与脱敏
- [x] `application/ports.ts`：`Logger` / `SecretStore` / `ConnectionStore` / `DriverFactory` 端口

**数据访问（3）**

- [x] `PostgresDriver`：pg Pool、`statement_timeout`、行映射与类型 OID 映射
- [x] 元数据查询：`pg_namespace` / `pg_class` / `pg_attribute` + 主键判定
- [x] 服务端取消：`pg_terminate_backend` + `release(true)`，仅作用于本连接后端

**应用服务（3）**

- [x] `ConnectionService`：CRUD、测试、连接/断开、SecretStorage 密码
- [x] `QueryService`：只读守卫、`maxRows` 钳制、取消登记
- [x] `SchemaService`：Promise 缓存 + 按连接失效

**宿主表现层（4）**

- [x] `MessageRouter`：信封 + payload 双层 Zod，信封 id 作为查询 id（可被 `query.cancel` 命中）
- [x] `ConnectionsTreeProvider`：懒加载、连接状态、Tables/Views 分组、列信息
- [x] `WorkbenchPanel`：宿主生成 HTML + CSP nonce、单例、事件转发
- [x] `extension.ts`：命令注册、状态栏、Disposable 注册

**Webview（3）**

- [x] `Transport` / `HostBridge` / `DemoTransport`：类型化请求、事件、持久化
- [x] Pinia `workbench` store + `App.vue` 工作台外壳
- [x] `ResultTable` 前端分页渲染、`ConnectionDialog` 表单、资源树点击预填 SQL

**验证与文档（4）**

- [x] 单元测试：激活 4 / 应用服务 12 / webview 4
- [x] 真库集成测试：连接、元数据、行映射、取消（`DATAFORGE_TEST_PG`）
- [x] 构建与打包：esbuild + Vite + vsce，VSIX 可安装
- [x] `README` / `LICENSE` / `docs/{architecture,dependencies,plan}.md`

## 4. Phase 2：数据编辑

### 4.1 设计前提

- **可编辑对象**：仅普通表与分区表（`relkind in ('r','p')`）；视图/物化视图/外部表默认只读，除非后续显式支持 `INSTEAD OF` 触发器。
- **行定位**：必须有主键（含复合主键）。无主键表在网格里禁用编辑并给出说明——这是硬约束，不做「按 `ctid` 更新」这种危险兜底。
- **参数化**：所有值走 `$1…$n`；标识符只来自服务端元数据并经白名单校验后双引号转义，绝不拼接用户输入。
- **乐观并发**：读取行时带上 `xmin`（系统列），更新/删除的 `WHERE` 里匹配 `xmin`；影响行数为 0 视为冲突并整体回滚。
- **事务**：提交时在**单个 client** 上显式 `BEGIN … COMMIT/ROLLBACK`；不复用池上的隐式事务。取消/异常必须 `ROLLBACK` 并销毁该 client。
- **危险操作确认**：删除行、批量提交、`TRUNCATE`/无 `WHERE` 的写语句走 VS Code 原生 modal 确认。

### 4.2 任务分解

| 批次 | 文件 | 内容 |
| --- | --- | --- |
| P2-1 领域模型 | `domain/data-edit.ts`、`domain/driver.ts`、`application/ports.ts` | 待提交变更集、行标识、可编辑判定、端口扩展 |
| P2-2 参数化写 | `infrastructure/postgres/postgres-driver.ts`、`infrastructure/postgres/sql-builder.ts` | 分页读取、参数化 insert/update/delete、`withTransaction`、标识符引用 |
| P2-3 编辑服务 | `application/data-editor-service.ts` + 测试 | `loadPage` / `validateChanges` / `commit` / `countRows` |
| P2-4 协议 | `shared/protocol.ts`、`presentation/message-router.ts` | `data.page` / `data.commit` / `data.export`，`PROTOCOL_VERSION` → 3 |
| P2-5 网格 | `webview/src/components/DataGrid.vue`、`webview/src/components/PendingBar.vue`、`webview/src/stores/data-editor.ts` | AG Grid 封装、待提交栏、commit/rollback |
| P2-6 导出 | `infrastructure/export/csv-exporter.ts`、`application/export-service.ts` | `pg-cursor` 流式 CSV + 保存对话框 |
| P2-7 收尾 | `webview/src/App.vue`、`docs/architecture.md` | 接线、文档更新 |

关键设计约束：`applyMutations` 必须 `pool.connect()` 取独占 client，`BEGIN` 后所有语句走该 client；`catch` 时 `ROLLBACK`，取消或状态不明时 `release(true)` 销毁连接。`data.commit` 的失败响应只携带冲突行主键，不回传整行旧值。

### 4.3 Todo List

**P2-1 领域模型（6）**

- [x] `domain/data-edit.ts`：`PendingChange`（insert/update/delete）与 `RowIdentity`
- [x] `domain/data-edit.ts`：`PendingChangeSet` 合并、冲突标记、回滚到初始快照
- [x] `domain/data-edit.ts`：`isEditableRelation` / `assertEditable`（仅 `r`、`p` 且必须有主键）
- [x] `domain/driver.ts`：`DataEditingDriver` 端口（`selectPage` / `applyMutations` / `countRows`）
- [x] `domain/driver.ts`：`DriverCapabilities`（事务、`RETURNING`、标识符引用符）
- [x] 单元测试：变更集合并与冲突标记（17 项）

**P2-2 基础设施（7）**

- [x] `sql-builder.ts`：`quoteIdentifier`（拒绝空串、含 NUL、超长标识符）
- [x] `sql-builder.ts`：`buildInsert` / `buildUpdate` / `buildDelete`，全部 `$n` 参数化
- [x] `sql-builder.ts`：`buildWhere`（主键 + `xmin` 乐观锁条件）
- [x] `postgres-driver.ts`：`selectPage`（`orderBy` 白名单 + `limit/offset` + 总数）
- [x] `postgres-driver.ts`：`applyMutations`（独占 client、BEGIN/COMMIT/ROLLBACK、异常 `release(true)`）
- [x] `postgres-driver.ts`：批量写返回 `rowCount` 与 `RETURNING` 行
- [x] 集成测试：真实 PG 上 insert/update/delete，`xmin` 不匹配时返回 0 行（10 项通过）

**P2-3 编辑服务（5）**

- [x] `DataEditorService.loadPage`：组装列、主键、`xmin` 与行数据
- [x] `DataEditorService.validateChanges`：类型 / 非空 / 长度校验
- [x] `DataEditorService.commit`：单事务内按顺序应用变更
- [x] 冲突映射：影响 0 行 → `conflict` 错误，携带主键列表（驱动层 `DataConflictError` + 事务回滚）
- [x] 单元测试：提交 / 回滚 / 冲突 / 参数断言（用 FakeDriver 记录 SQL 与参数，14 项）

**P2-4 协议与路由（4）**

- [x] `protocol.ts`：`data.page` / `data.commit` 请求类型与结果 DTO（`data.export` 挪到 P2-6）
- [x] `protocol.ts`：冲突错误扩展（`conflictingKeys`），`PROTOCOL_VERSION` → 3
- [x] `message-router.ts`：新 payload 的 Zod schema（行数上限、变更条数上限）
- [x] `message-router.ts`：分发与结果映射，复用既有错误码

**P2-5 网格 UI（6）**

- [x] 安装 `ag-grid-community` / `ag-grid-vue3` 36.3.0，用 `themeQuartz.withParams` 绑定设计令牌（跟随 VS Code 主题）
- [x] `DataGrid.vue`：只读展示模式 + 编辑模式（`getRowId` 用主键拼接）
- [x] `DataGrid.vue`：单元格编辑、新增行、删除标记、键盘导航（Delete 标记删除）
- [x] `PendingBar.vue`：变更计数、撤销、Commit / Rollback
- [x] `stores/data-editor.ts`：分页/排序状态与待提交变更（筛选留待后续）
- [x] 危险操作确认（删除行、批量提交）用内联确认条，不遮挡网格

**P2-6 导出（4）**

- [x] `infrastructure/export/csv.ts`：RFC 4180 转义（引号、换行、分隔符）与流式写出
- [x] `export-service.ts`：复用连接 + `pg-cursor` 分批读取（每批 1000 行），补 `data.export` 协议请求/DTO
- [x] 导出入口：webview「Export CSV」按钮 + 宿主 `vscode.window.showSaveDialog`（路径只由宿主选择）
- [x] 单元测试：转义、换行、多分隔符；导出集成测试（2500 行流式写出 + 特殊字符）

**P2-7 收尾（3）**

- [x] webview 集成到工作台（「查询 / 数据」标签切换）
- [x] 文档更新：`architecture.md` 数据编辑流程 + CSV 导出、`dependencies.md` AG Grid / pg-cursor
- [x] 全链路集成测试：编辑 → 提交 → 回读（`data-editor.integration.test.ts`：分页身份/版本、视图只读、增删改单事务、过期版本冲突回滚）

### 4.4 验收清单（Definition of Done）

- [x] 无主键表、视图：网格只读并说明原因，不出现可点击的编辑入口
- [x] 所有写语句参数化；SQL 日志中不出现拼接后的字面值
- [x] 并发修改同一行时，提交失败并提示冲突主键，事务回滚、无部分写入
- [x] 取消提交后事务回滚、连接释放（`data.commit` 登记 `AbortController`；`applyMutations` 在语句之间检查取消，已发出的语句无法撤回，详见第 7 节）
- [x] 分页/排序/筛选在服务端执行，10 000 行上限仍然生效（分页走 `limit/offset` + `count(*)`；筛选留待后续）
- [x] CSV 导出 10 万行以上不阻塞 UI，可取消（`pg-cursor` 流式写出；`data.cancel` 中止后删除半成品文件）
- [x] 集成测试覆盖：提交、回滚、冲突、CSV 转义

## 5. Phase 3

| 任务 | 实现位置 | 说明 |
| --- | --- | --- |
| SQL 补全 | `extension/src/presentation/completion.ts` | `registerCompletionItemProvider('sql')`，候选来自 `SchemaService` 缓存（schema/表/列），按前缀过滤 |
| SQL 格式化 | `extension/src/application/format-service.ts` | `sql-formatter@15.9.0`，宿主侧执行，格式化选区或全文后回填 |
| 查询历史 | `extension/src/application/history-service.ts` | `globalState` 有界队列（建议 200 条，含连接/耗时/时间/成功与否） |
| 耗时与诊断 | `extension/src/presentation/diagnostics.ts` | 复用 `durationMs`；慢查询阈值可配（如 > 1 s 记警告 + 状态栏） |
| EXPLAIN | `extension/src/application/query-service.ts`（改） | `explain (format json) <sql>`，只读事务包裹，结果树形或 JSON 文本 |
| 显式事务会话 | 新增 `QuerySession` 抽象 | 单 client 的 `begin/commit/rollback`，与连接绑定；同一连接同时只允许一个会话 |

Phase 3 不重写编辑器：补全/格式化/诊断全部通过 VS Code 语言 API 挂到既有编辑器上。

### 5.1 Todo List

**补全（3）**

- [x] `presentation/completion.ts`：SQL 关键字 / schema / 表 / 列提供者
- [x] `presentation/completion.ts`：表/列候选基于 `SchemaService` 缓存，未连接时降级为空
- [x] 单元测试：候选生成、去重、前缀过滤

**格式化（3）**

- [x] 引入 `sql-formatter@15.9.0`，注册命令 `dataforge.formatSql`
- [x] 支持选区优先、否则格式化全文；使用 VS Code 编辑接口保证可撤销
- [x] 单元测试：格式化失败不破坏原文

**历史与诊断（3）**

- [x] `history-service.ts`：`globalState` 有界队列（200 条）与去重
- [x] 历史命令 / 视图：选择历史回填编辑器
- [x] 状态栏耗时 + `dataforge.slowQueryMs` 慢查询阈值

**EXPLAIN 与事务（3）**

- [x] EXPLAIN 按钮与结果面板（JSON 文本，不渲染成树）
- [x] `QuerySession`：`BEGIN` / `COMMIT` / `ROLLBACK`，与连接绑定
- [x] 会话泄漏防护：面板关闭 / 扩展停用时自动回滚

## 6. Phase 4

| 步骤 | 内容 |
| --- | --- |
| 1 | `ConnectionProfile` 增加 `kind: 'postgresql' \| 'mysql' \| 'sqlite' \| 'sqlserver'`（协议 v4），默认 `postgresql`，迁移旧数据 |
| 2 | `DriverFactory` 按 `kind` 选择；树视图图标/节点类型不变 |
| 3 | 每个驱动实现 `DatabaseDriver`，能力差异通过 `capabilities` 暴露（是否支持事务、`RETURNING`、标识符引用符） |
| 4 | 仅当第二个驱动真正落地时才把 `sql-builder` 中的方言差异抽出来；不在 Phase 2/3 预埋 |

### 6.1 Todo List

- [x] `protocol.ts` v4：`ConnectionProfile.kind` 与 `ConnectionSummary.kind`
- [x] `ConnectionProfile` 持久化迁移：缺省 `postgresql`
- [x] `DriverFactory` 按 `kind` 路由（`extension.ts` 组合根）
- [x] `DriverCapabilities` 接口落地，PostgreSQL 驱动先实现
- [x] 第二个驱动 MySQL 只读 MVP：连接、元数据、查询（`infrastructure/mysql/mysql-driver.ts`）
- [x] 驱动实现指南文档 `docs/drivers.md` + 新建连接时的类型选择 UI

## 7. 跨阶段工程化待办

### 7.1 Todo List

- [x] `.gitignore` 覆盖构建产物、`*.vsix`、`.tmp/`、`.vscode-test/`
- [x] UI 组件库调研（`brutxui` 不存在、`brutx-ui` 是 React、`neobrutalism-vue` 维护风险 → 自建设计令牌）
- [ ] 首次 git commit（当前仓库零提交、全部文件未跟踪）
- [ ] 替换 `webview/e2e/vue.spec.ts`（仍断言 `You did it!`，已失效）
- [ ] 移除未使用依赖 `vite-plugin-vue-devtools`；`tailwindcss` 移入 `devDependencies`
- [ ] `npm audit --omit=dev` 处理安装时报告的 5 个 moderate
- [ ] CI：type-check + unit + lint + package；PostgreSQL 用 service container 跑集成测试
- [ ] 发布元数据：真实 `publisher`、`repository`、`icon`，并把 `LICENSE` 打进 VSIX
- [ ] 性能预算与可访问性清单（大结果集、键盘导航、对比度）

**工程化补充（2）**

- [x] `data.commit` / `data.export` 支持取消：登记请求级 `AbortController`，取消时回滚事务并删除导出半成品
- [ ] 关闭工作台时提示「仍有 N 条未提交变更」，避免静默丢失

## 8. 里程碑

| 里程碑 | 内容 | 完成标志 |
| --- | --- | --- |
| M1 | Phase 1 交付 | 已达成 |
| M2 | Phase 2 只读→可编辑闭环（P2-1…P2-5） | 网格编辑 + 提交/回滚 + 冲突提示 |
| M3 | Phase 2 导出与收尾（P2-6、P2-7） | CSV 可导出、文档与集成测试齐备 |
| M4 | Phase 3 体验增强 | 补全/格式化/历史/EXPLAIN 可用 |
| M5 | Phase 4 多驱动 | 第二个驱动只读 MVP 跑通 |

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| AG Grid Community 无服务端行模型 | 大表分页需自研 | 用 `limit/offset` + `count(*)`；超过阈值切 keyset 分页（按主键游标）；明确不支持无限滚动 |
| 编辑冲突语义复杂 | 数据被覆盖 | `xmin` 乐观锁 + 0 行更新即冲突 + 整体回滚；不做 last-write-wins |
| 事务期间连接被占用 | 连接池饥饿 | 会话独占单 client，池上限 4，超时即失败并提示；禁止在同一连接并发开两个会话 |
| 视图误编辑 | 数据不一致 | 仅 `relkind r/p` 可编辑；能力开关在服务端判定，前端只做展示 |
| 大结果/大导出 | 内存与 UI 卡顿 | 行数上限 + 网格分页 + 导出流式 + 可取消 |
| 补全依赖元数据缓存 | 缓存过期导致错误建议 | 缓存按连接失效；补全候选仅作提示，不改变语义 |
