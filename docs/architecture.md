# DataForge 架构

> 状态：Phase 1 已实现并验证。本文描述当前代码的真实结构；Phase 2–4 的规划见 [plan.md](./plan.md)。

## 1. 定位

DataForge 是 VS Code 里的 PostgreSQL IDE。第一阶段只做「连得上、看得见、查得动」：

- 连接的增删改查、连通性测试、密码托管；
- 资源树按需浏览 schema / 表 / 视图 / 列（类型、主键、可空、默认值）；
- 在工作台里执行整段 SQL 或选中片段，表格展示结果，可取消、有超时、有行数上限。

MySQL / SQLite / SQL Server 预留在 `DatabaseDriver` 端口后面，但当前没有任何为了「未来可能」而存在的抽象。

## 2. 进程与信任边界

```text
┌──────────────────────────────────────────────────────────────────┐
│ Extension Host（Node.js，完全可信）                                │
│                                                                  │
│  extension.ts  命令 / 状态栏 / 资源树 / 面板装配                   │
│      │                                                           │
│      ├── application  ConnectionService  QueryService  SchemaService
│      │        │                                                  │
│      │        └── ports: Logger / SecretStore / ConnectionStore /  │
│      │                    DriverFactory / DatabaseDriver           │
│      ├── infrastructure  PostgresDriver(pg)  SecretStorage  Memento
│      └── presentation    MessageRouter  WorkbenchPanel  TreeView   │
└───────────────▲──────────────────────────────┬────────────────────┘
                │ postMessage（结构化消息）       │ pg 协议（TCP）
                │ 不可信输入，全部 Zod 校验       │
┌───────────────┴──────────────┐        ┌──────▼───────────────────┐
│ Webview（浏览器沙箱，不触网） │        │ PostgreSQL               │
│ Vue 3 + Pinia + Tailwind      │        └──────────────────────────┘
└───────────────────────────────┘
```

两条硬边界：

1. **Webview 只能拿到 DTO。** 它不知道 `pg` 的存在，也没有任何数据库凭证；`ConnectionSummary` 里没有密码字段。
2. **宿主不信任 Webview 的任何消息。** `MessageRouter` 先校验信封（`kind/id/type`），再按 `type` 校验 payload，校验失败直接回 `invalid_request`，服务层永远见不到脏数据。

## 3. 分层与依赖规则

```text
domain        ← application ← infrastructure
   ↑               ↑
   └──────── presentation ──→ shared（无依赖协议内核）
```

| 层 | 目录 | 允许依赖 | 职责 |
| --- | --- | --- | --- |
| domain | `extension/src/domain` | 仅 `@shared/protocol` 类型 | 实体的构造与不变量：`createProfile`、`clampPort`、`sameProfileName`、错误码与脱敏、`DatabaseDriver` 端口类型 |
| application | `extension/src/application` | domain + ports | 用例编排：连接生命周期、查询执行与取消、元数据缓存、数据编辑与导出、历史记录、格式化、补全数据源、事务会话；不 import `vscode`/`pg` |
| infrastructure | `extension/src/infrastructure` | application ports + domain + `pg`/`vscode` | `PostgresDriver`、SQL 构造器、CSV 编码、`VsCodeSecretStore`、`MementoConnectionStore` |
| presentation | `extension/src/presentation` | application + shared + `vscode` | 原生树、命令入口、Webview 面板、消息路由、日志通道 |
| shared | `shared/protocol.ts` | 无（纯类型 + 常量） | 双端共用的消息契约、`PROTOCOL_VERSION`、DTO |

依赖方向靠构造参数注入维持：`extension.ts` 是唯一的组合根，任何服务都不 `new` 另一个服务。

## 4. 模块清单

| 文件 | 关键导出 | 说明 |
| --- | --- | --- |
| `shared/protocol.ts` | `PROTOCOL_VERSION`(=4)、`ConnectionKind`、`RequestCatalogue`、`WebviewRequest`、`HostMessage`、`HostEvent` | 请求/响应/事件三种消息的唯一定义；`REQUEST_TYPES` 是 Zod 校验的白名单来源 |
| `extension/src/domain/connection.ts` | `ConnectionProfile`、`ConnectionConfig`、`createProfile`、`KIND_DEFAULTS`、`clampPort`、`sameProfileName` | 密码不进入 profile；`kind` 决定默认端口/库/用户（PostgreSQL `5432/postgres`、MySQL `3306/mysql`）；`ssl` 默认 `require`、`readOnly=false` |
| `extension/src/domain/errors.ts` | `DataForgeError`、`toErrorDto`、`wrapError`、`redactSecrets` | 统一错误码；脱敏 `password=…`、`pwd=…`、`postgres://user:pass@` |
| `extension/src/domain/driver.ts` | `DatabaseDriver`、`DriverCapabilities`、`DriverSession`、`DataEditingDriver`、`TableExportDriver`、`TransactionalDriver` | 驱动端口；`kind` 限定为 `ConnectionKind`，`capabilities?` 描述事务/`RETURNING`/标识符引用；编辑/导出/事务都是可选能力接口，新增数据库只实现 `DatabaseDriver` 即可 |
| `extension/src/application/ports.ts` | `Logger`、`SecretStore`、`ConnectionStore`、`DriverFactory`、`Emitter` | 依赖倒置点；`Emitter` 是唯一的事件原语，无事件总线 |
| `extension/src/application/connection-service.ts` | `ConnectionService` | `profiles` / `drivers` / `runtime` 三张表；`list()` 产出脱敏后的 `ConnectionSummary`；断连时销毁池 |
| `extension/src/application/query-service.ts` | `QueryService`、`isReadOnlyStatement`、`clampMaxRows` | 以请求 id 登记 `AbortController`；只读连接在到达驱动前拦截写语句；行数上限 10 000 |
| `extension/src/application/schema-service.ts` | `SchemaService` | 三层 Promise 缓存（schemas / relations / columns），失败即删除缓存项，`invalidate()` 支持整库或单连接 |
| `extension/src/domain/data-edit.ts` | `PendingChangeSet`、`assertEditable`、`identityKey`、`primaryKeyColumns` | 可编辑性判定（仅 `table`/`partitioned table` 且有主键）、主键身份键、待提交变更的合并/冲突/快照 |
| `extension/src/application/data-editor-service.ts` | `DataEditorService`、`DataPage`、`ChangeIssue`、`CommitResult` | 分页读取 + 服务端校验 + 单事务提交；冲突时整体回滚；只读连接在到达驱动前拦截 |
| `extension/src/infrastructure/postgres/sql-builder.ts` | `buildPageQuery`、`buildInsert`、`buildUpdate`、`buildDelete`、`quoteIdentifier` | 所有写语句参数化；标识符双引号转义并拒绝空/NUL/超 63 字符；排序限制在已选列 |
| `extension/src/application/export-service.ts` | `ExportService`、`isTableExportDriver` | 复用连接流式导出；失败删除半成品文件 |
| `extension/src/application/history-service.ts` | `HistoryService`、`HistoryEntry`、`HISTORY_LIMIT`(=200) | 有界历史；连续重复合并；写入失败只记日志，不影响查询 |
| `extension/src/application/format-service.ts` | `FormatService`、`formatSql`、`safeFormatSql` | `sql-formatter` 的 postgresql 方言；空输入报 `invalid_request`，失败返回 `null` 让调用方保留原文 |
| `extension/src/application/query-session-service.ts` | `QuerySessionService`、`isTransactionalDriver` | 每连接一个 `DriverSession`；重复 `begin`、未开启操作都报错；`rollbackAll()` 用于清理泄漏 |
| `extension/src/presentation/completion.ts` | `createSqlCompletionProvider`、`candidatesFor`、`splitQualifier` | 关键字 + schema/表/列；只用缓存，未连接降级为空 |
| `extension/src/presentation/diagnostics.ts` | `createQueryDiagnostics` | 状态栏耗时/失败 + 慢查询日志（阈值 `dataforge.slowQueryMs`） |
| `extension/src/infrastructure/cells.ts` | `toCellValue` | 各驱动共用的单元格归一化（Date→ISO、bigint→字符串、Buffer→十六进制） |
| `extension/src/infrastructure/export/csv.ts` | `CsvWriter`、`escapeCsvField` | RFC 4180 转义，默认 CRLF，支持 `,`/`;`/`\t` |
| `extension/src/infrastructure/postgres/postgres-driver.ts` | `PostgresDriver`、`mapPgError`、`PostgresSettings` | 池上限 4、空闲 30 s、`statement_timeout` 在 `onConnect` 注入；数组行模式；取消走 `pg_terminate_backend`；实现 `DataEditingDriver`、`TableExportDriver`（`pg-cursor`）与 `TransactionalDriver`（`openSession` 独占 client） |
| `extension/src/infrastructure/mysql/mysql-driver.ts` | `MySqlDriver`、`mapMySqlError`、`MySqlSettings` | `mysql2` 连接池；`dateStrings` 保留时间原文、`bigNumberStrings` 防精度丢失；取消走独立连接 `KILL QUERY`；`max_execution_time` 逐连接懒设置（只约束 SELECT）；只实现 `DatabaseDriver` |
| `extension/src/infrastructure/security/secret-store.ts` | `VsCodeSecretStore` | key 形如 `dataforge.connection.<id>.password` |
| `extension/src/infrastructure/persistence/connection-store.ts` | `MementoConnectionStore` | `globalState['dataforge.connections.v1']`，逐条 Zod 校验，坏数据静默丢弃 |
| `extension/src/infrastructure/persistence/history-store.ts` | `MementoHistoryStore` | `globalState['dataforge.history.v1']`，Zod 校验后整体读取；只存 SQL 文本与耗时，不含结果行 |
| `extension/src/presentation/message-router.ts` | `MessageRouter` | 信封 + payload 校验，`switch` 分发，统一包装成功/失败响应 |
| `extension/src/presentation/connections-tree.ts` | `ConnectionsTreeProvider` | 懒加载树；连接节点 `contextValue = dataforge.connection.<state>` 供菜单 `when` 使用 |
| `extension/src/presentation/workbench-panel.ts` | `WorkbenchPanel` | 单例面板；宿主生成 HTML + 每次加载随机 nonce；`prefill()` 支持握手前排队 |
| `extension/src/presentation/logging.ts` | `OutputChannelLogger` | 所有日志先脱敏；错误附带堆栈 |
| `extension/src/extension.ts` | `activate` / `deactivate` | 组合根：读配置、装配服务、注册 9 个命令与 SQL 补全提供者、状态栏、`context.subscriptions` 统一释放 |
| `webview/src/lib/host.ts` | `HostBridge`、`DemoTransport`、`HostRequestError` | webview 侧协议客户端；浏览器里自动切到演示宿主，方便纯前端调试 |
| `webview/src/stores/workbench.ts` | `useWorkbenchStore` | 唯一状态源：连接、SQL、结果、错误、toast、EXPLAIN 结果、显式事务状态；`runQuery(selection?)` 携带调用方生成的 requestId，事务开启时改发 `transaction.run` |
| `webview/src/components/ResultTable.vue` | `ResultTable` | 先渲染 200 行，其余按需展开，避免大结果一次性入 DOM |
| `webview/src/stores/data-editor.ts` | `useDataEditorStore` | 数据页状态：分页/排序、待提交变更、冲突键、导出中标志；`commit()` / `exportCsv()` 只发请求，不拼 SQL |
| `webview/src/components/DataGrid.vue` | `DataGrid` | AG Grid Community + `themeQuartz`；行状态着色；排序/分页/键盘删除；`xmin` 随行携带 |
| `webview/src/components/PendingBar.vue` | `PendingBar` | 变更计数、撤销、内联确认条（提交/删除）、导出 CSV 按钮 |
| `webview/src/components/ConnectionDialog.vue` | `ConnectionDialog` | 新建/编辑共用；测试连接可只发草稿，不落库 |

## 5. 协议

### 5.1 三类消息

```ts
// Webview → Host
{ kind: 'request', id: string, type: RequestType, payload: RequestInput<T> }

// Host → Webview
{ kind: 'ready',  payload: BootstrapPayload }                    // 握手应答
{ kind: 'response', payload: WebviewResponse | ResponseError }   // 与请求同 id
{ kind: 'event',  payload: HostEvent }                           // 主动推送
```

`id` 由 webview 生成；`query.execute` 的 id 直接被 `QueryService` 当作执行键，因此 `query.cancel` 只需回传 `targetRequestId`。

### 5.2 请求目录

| type | payload → 结果 |
| --- | --- |
| `workbench.ready` | `null` → `null`（宿主改回 `ready` 消息） |
| `connection.list` | `null` → `ConnectionSummary[]` |
| `connection.create` | `ConnectionDraft` → `ConnectionSummary` |
| `connection.update` | `{ id } & Partial<ConnectionDraft>` → `ConnectionSummary` |
| `connection.delete` | `{ id }` → `null` |
| `connection.test` | `{ connectionId? , draft? }` → `{ serverVersion, database, user, latencyMs }` |
| `connection.connect` / `connection.disconnect` | `{ id }` → `ConnectionSummary` |
| `query.execute` | `{ connectionId, sql, maxRows }` → `QueryResultDto` |
| `query.cancel` | `{ targetRequestId }` → `null` |
| `query.explain` | `{ connectionId, sql }` → `{ plan, durationMs }`（`explain (format json)`，只接受单条只读语句） |
| `data.page` | `{ connectionId, schema, relation, limit, offset, orderBy }` → `DataPageDto` |
| `data.commit` | `{ connectionId, schema, relation, changes }` → `{ inserted, updated, deleted, returnedKeys }` |
| `data.export` | `{ connectionId, schema, relation }` → `{ saved, path?, rowCount? }`（宿主负责选路径；`saved:false` 表示用户取消） |
| `data.cancel` | `{ targetRequestId }` → `null`（中止正在进行的 `data.commit` / `data.export`） |
| `transaction.begin` / `transaction.commit` / `transaction.rollback` | `{ connectionId }` → `{ connectionId, active }` |
| `transaction.run` | `{ connectionId, sql, maxRows }` → `QueryResultDto`（在该连接的会话内执行） |

### 5.3 事件

| event | 用途 |
| --- | --- |
| `connections.changed` | 连接状态变化后刷新列表与计数 |
| `toast` | 宿主侧提示（如后台池错误） |
| `editor.prefill` | 资源树点击表/视图时把 `select * from "schema"."relation" limit 100;` 填进编辑器，并带上 `target` 让工作台切到「数据」页签 |

### 5.4 时序

**启动握手**

```text
App mount → store.initialize()
  → host.ready()  ── workbench.ready ──▶  WorkbenchPanel
  ◀── ready { protocolVersion, connections, prefs } ──
  → 恢复持久化的 activeConnectionId / sql
  → 订阅 event；watch([activeConnectionId, sql]) 写回 getState
```

**执行与取消**

```text
Run → runQuery() 生成 uuid → request(query.execute, id=uuid)
  → MessageRouter 校验 → QueryService.execute(uuid)
  → PostgresDriver.query() 取连接、注入 statement_timeout、rowMode=array
  ◀── rows（截断到 maxRows）+ command/affectedRows/durationMs
Cancel → request(query.cancel, { targetRequestId: uuid })
  → AbortController.abort() → 该后端执行 pg_terminate_backend(pg_backend_pid())
  → 客户端以 release(true) 销毁，绝不回池
```

**资源树打开表**

```text
relation 节点 command = openWorkbench({ connectionId, schema, relation })
  → extension.ts 校验参数 → quoteIdentifier() 转义 → WorkbenchPanel.prefill()
  → 若面板尚未握手则排队；ready 后以 editor.prefill 事件下发
  → store 写入 sql、切换连接（仅当该 id 仍在列表中）
  → 事件带 target 时切到「数据」页签并打开该表
```

### 5.5 数据编辑与导出

```text
点击 relation → editor.prefill(target) → store 切到 Data 页签
  → request(data.page) → DataEditorService.loadPage()
  → listRelations/listColumns（缓存）→ assertEditable()
  → driver.selectPage({ columns, identityColumns, withVersion: editable })
  ◀── DataPageDto { columns, primaryKey, rows, totalRows, editable, readOnlyReason? }

编辑单元格 / 新增行 / 标记删除 → PendingChangeSet（前端只记差异）
Commit → 内联确认条 → request(data.commit)
  → DataEditorService.commit()：只读连接拒绝 → assertEditable → 服务端逐值校验
  → driver.applyMutations()：单个 pool.connect() → BEGIN → 每条 $n 参数化语句 → COMMIT
      · UPDATE/DELETE 带 `xmin::text = $n`，影响 0 行即记为冲突
      · 任一冲突或 SQL 错误 → ROLLBACK → DataConflictError（只回传冲突主键）
  ◀── { inserted, updated, deleted, returnedKeys } → 重新加载当前页

Export CSV → request(data.export)
  → 宿主 showSaveDialog 选路径（webview 不碰文件系统）
  → ExportService：CsvWriter 写表头 → driver.exportTable() 用 pg-cursor 每批 1000 行
  → 写入流 await 背压；失败删除半成品
```

编辑只允许 `table` / `partitioned table` 且有主键：视图、物化视图、外部表、无主键表返回 `editable:false` 并说明原因。前端不做 SQL 拼接，`record` 差异只作为数据传给宿主。

### 5.6 补全、历史与显式事务

```text
补全：在 .sql 编辑器里输入 → provider 只读 SchemaService 缓存（不触发 I/O）
  → splitQualifier() 取 `schema.` / `table.` 前缀 → filterByPrefix() → CompletionList
  → 未连接或缓存为空时只给关键字

格式化：命令 dataforge.formatSql → activeTextEditor 的选区（否则全文）
  → FormatService(sql-formatter, postgresql) → WorkspaceEdit.replace + applyEdit
  → 通过编辑接口写入，Ctrl+Z 可撤销；失败保持原文

历史：QueryService 每次执行结束 → HistoryService.record()（不 await、不抛错）
  → globalState 有界 200 条，连续重复合并 → 命令回填当前编辑器或工作台

事务：Begin → transaction.begin → QuerySessionService.begin()
  → driver.openSession()：独占 client + BEGIN，登记在 sessions Map
  → 该连接之后的运行改走 transaction.run（同一 client，不走池）
  → Commit / Rollback → COMMIT / ROLLBACK 后 release；同一连接只允许一个会话
  → 工作台关闭 / 扩展停用 / 连接断开 → rollbackAll()，失败只记日志
```

事务不跨连接、不跨面板：会话与 `connectionId` 绑定，切换连接会被前端拒绝；租约由宿主持有，webview 拿不到 client。

## 6. 安全设计

| 威胁 | 措施 |
| --- | --- |
| 密码泄漏到 webview / 日志 / Memento | 密码只在 `SecretStorage`；`ConnectionSummary` 无密码字段；日志统一 `redactSecrets`；profile 落盘前 schema 里就没有 password |
| 恶意/损坏的 webview 消息 | 信封 + payload 双层 Zod；`REQUEST_TYPES` 白名单；未知消息只记日志不执行 |
| XSS | Vue 默认文本插值，全程不用 `v-html`；CSP `default-src 'none'`，`script-src 'nonce-…'`，`connect-src 'none'` |
| 资源路径逃逸 | `localResourceRoots` 限定到 `dist/webview`，资源经 `asWebviewUri` |
| 误写生产库 | 连接级 `readOnly` + `isReadOnlyStatement()` 词法守卫（剥注释/字符串/引号标识符后判断首关键字，拒绝多语句与 `WITH … INSERT/UPDATE/DELETE`）；最终防线仍是数据库角色权限 |
| 超长/失控查询 | `statement_timeout`（可配，0 表示关闭）、`clampMaxRows`（≤10 000）、可取消、结果截断标记 `truncated` |
| 错误信息带凭证 | `mapPgError` 归一化错误码，`toErrorDto` 脱敏后再回传 |
| 池泄漏 | `disconnect`/`delete`/`update`/`dispose` 都 `end()` 池；终止过的连接强制销毁 |
| 后台池错误淹没用户 | `pool.on('error')` → `onBackgroundError` → 日志通道，不打断当前请求 |
| 拼接 SQL / 注入标识符 | 写语句全部 `$n` 参数化；列名、schema、表名经 `quoteIdentifier` 转义（双引号翻倍、拒绝空/NUL/超 63 字符），排序列必须属于已选列 |
| 误改无主键表或视图 | `assertEditable` 只放行有主键的 `table`/`partitioned table`；其它关系返回只读原因，写入口被禁用 |
| 并发覆盖别人的修改 | 每行携带 `xmin`，UPDATE/DELETE 带 `xmin::text = $n`；影响 0 行即冲突，整批 `ROLLBACK`，只回传冲突主键 |
| 导出路径被 webview 指定 | 路径只由宿主 `showSaveDialog` 产生；`data.export` 的 payload 只有连接与关系名 |

## 7. 性能与生命周期

- **懒加载**：激活时只读连接配置，不连库、不拉 schema；展开节点才发查询。
- **缓存**：`SchemaService` 缓存 Promise（避免并发重复查询），连接断开或元数据变更时按连接失效。
- **结果有界**：SQL 侧 `maxRows` 截断，表格侧分页 200 行；`durationMs` / `command` / `affectedRows` 只是标量。
- **分页在服务端**：`data.page` 用 `limit/offset` + `count(*)`，每页最多 1000 行；排序在 SQL `order by` 中完成，不在前端重排。
- **导出流式**：`pg-cursor` 每批 1000 行，写文件按回调背压；整表不进内存，也不经过 webview。
- **时序安全**：中止信号同时用于 SQL 取消与 `release(true)`，避免把被终止的后端放回池。
- **释放**：面板 `dispose` → 摘事件、销毁 HTML；扩展 `deactivate` 依赖 `context.subscriptions` 逐个 dispose，`ConnectionService.dispose()` 结束所有池。
- **单面板**：工作台是单例，重复点击只 `reveal`，不会堆积 webview 实例。

## 8. 扩展点与取舍

**新增数据库驱动**：实现 `DatabaseDriver`（`testConnection` / `query` / `listSchemas` / `listRelations` / `listColumns` / `dispose`），在 `DriverFactory` 里按连接类型选择。协议里的 `DatabaseDriver.kind` 已预留，但 `ConnectionProfile` 目前没有 `kind` 字段——Phase 4 加驱动时再一并引入，避免现在多一层分支。

**为什么宿主自己写 HTML**：CSP 的 nonce 必须每次加载重新生成，且只允许加载打包产物；如果让 Vite 的 `index.html` 直接进包，nonce 与资源路径都要二次改写。代价是 Vite 必须产出稳定文件名（`assets/index.js`、`assets/index.css`），已在 `webview/vite.config.ts` 固化。

**为什么取消用 `pg_terminate_backend` 而不是 `pg_cancel_backend`**：取消别人的后端需要超级用户或同角色；终止自己的后端用独立短连接即可，代价是该连接不能复用——换来的是「取消一定生效」。

**为什么没有事件总线 / CQRS**：当前只有「连接状态变化」和「编辑器预填」两类事件，`Emitter` + postMessage 已经够用；引入事件框架只会增加跨层依赖。

## 9. 已知缺口

- webview 未校验 `PROTOCOL_VERSION` 是否与宿主一致（同包构建，风险低；协议一旦跨版本需补校验）。
- 只读守卫是词法级的，不解析 CTE 内的写操作之外的花样（如 `select … into`、函数副作用），权限仍是唯一强保证。
- SQL 查询结果本身仍是一次性返回（受 `maxRows` 约束）；只有 CSV 导出是流式的。
- 数据编辑与导出可取消，但取消粒度到「语句之间」：`AbortController` 在每条语句前检查，已发出的语句无法撤回；事务仍会 `ROLLBACK`，导出半成品文件会被删除。
- 关闭工作台会自动回滚宿主侧未提交的显式事务（`onClose → rollbackAll`），但 webview 内存里的待提交单元格变更仍会丢失。
- 查询历史把 SQL 原文存进 `globalState`，其中的字面量（邮箱、手机号等）没有额外脱敏；历史是可清空的本机数据，不随连接走。
- 事务会话只支持单连接、单会话：同一连接开第二个事务会被拒绝，跨连接事务不在范围内。
- MySQL 驱动目前只有查询与元数据：数据编辑、CSV 导出、显式事务都未实现（`DataEditingDriver` / `TableExportDriver` / `TransactionalDriver` 缺席），界面会收到 `internal` 错误而不是静默失败。
- `ConnectionKind` 已声明 `sqlite` / `sqlserver`，但没有对应驱动：`createDriver` 对未实现的 kind 抛 `internal`，新建连接的类型下拉只列 PostgreSQL 与 MySQL。
- AG Grid 36 让 webview 产物增至约 1.28 MB（gzip 380 KB），尚未做按需加载或代码分割。
- 打包进 `mysql2` 后宿主 bundle（`dist/extension.js`）约 1.9 MB；两个驱动都在激活时加载，尚未按 `kind` 懒加载。
- `webview/e2e/vue.spec.ts` 仍是脚手架残留（断言 `You did it!`），未纳入 CI；见 [plan.md](./plan.md) 的工程化待办。
- 发布元数据仍是占位：`publisher: "dataforge"`、缺少 `repository` 字段。
