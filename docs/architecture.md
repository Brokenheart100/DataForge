# DataForge 架构（DataGrip 对齐版）

目标：在 VS Code 内提供与 DataGrip 等价的核心工作流——多数据源、按库作用域浏览、
多控制台、对象与结构管理、导入导出、事务与运维视图。本文描述**目标架构**以及
从 0.1.3 演进到它的路径；能力矩阵与阶段划分见 [datagrip-parity.md](datagrip-parity.md)。

## 1. 边界与约束

- 宿主：VS Code Extension Host（Node 22+，CommonJS 打包），窗口内只有**一个**
  DataForge 扩展实例；Webview 只是渲染层。
- 数据访问只在宿主：Webview 永不接触驱动、连接串或密码；所有请求经 postMessage +
  Zod 校验，返回 DTO。
- 不重写编辑器：SQL 编辑仍用 VS Code 文本编辑器（补全/格式化/诊断走语言 API），
  Webview 只负责控制台标签、结果网格与对象编辑对话框。
- 驱动即插件：任何新数据库只实现 `DatabaseDriver` 及可选能力接口，不引入
  ORM、查询 DSL 或通用 SQL 解析器。
- 安全默认：密码进 SecretStorage，写操作参数化，标识符统一引用，危险操作二次确认。

## 2. 当前状态（0.1.4）

已交付：连接管理（PostgreSQL/MySQL）、资源树（连接 → Databases → 库 → Schemas →
表/视图 → 列）、按库作用域浏览（副库只读）、库切换、SQL 执行与结果网格、取消、
数据编辑（事务化提交 + `xmin` 乐观锁）、CSV 导出、补全、格式化、历史、EXPLAIN、
显式事务会话、状态栏计时、CI/CD 与 Marketplace 发布。

关键差距：没有多控制台；对象浏览器只有树，没有搜索/DDL/统计；没有导入；
没有结构编辑；只有两个驱动。

## 3. 目标架构

```text
┌──────────────────────────── VS Code Extension Host ────────────────────────────┐
│ presentation   commands · tree(ObjectExplorer) · webview panel · router · log   │
│      │                                                                          │
│ application    datasource·scope · console · object · ddl · import/export ·      │
│      │         session-monitor · query/schema/data-editor/export/session        │
│      │                                                                          │
│ domain         profiles · scopes · driver ports · pending changes · ddl model   │
│      │                                                                          │
│ infrastructure postgres · mysql · (sqlite/sqlserver) · ssh tunnel · secret store│
└───────────────┬─────────────────────────────────────────────────────────────────┘
                │ typed protocol (Zod, requestId, events)
┌───────────────┴──────────────── Webview (Vue 3 + Pinia + AG Grid) ──────────────┐
│ consoles · result grid · object dialogs · import wizard · session/lock panel    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 新增核心抽象

| 抽象 | 位置 | 责任 |
| --- | --- | --- |
| `DataSourceScope` | `domain/scope.ts` | `{connectionId, database}`；所有元数据与查询的作用域键（已交付） |
| `DriverRegistry` | `application/driver-registry.ts` | 按 `ConnectionKind` 创建驱动，能力矩阵查询 |
| `ScopePools` | `application/connection-service.ts` | 每作用域一个 pool，主库池用于控制台/事务，副库池只读浏览，统一释放（已交付） |
| `ConsoleService` | `application/console-service.ts` | 控制台生命周期：新建/复制/关闭、绑定作用域、执行与取消、结果保留 |
| `ObjectService` | `application/object-service.ts` | 对象搜索、DDL 读取、依赖与统计（大小/行数/索引） |
| `DdlPlanner` | `application/ddl-planner.ts` | 由结构化变更生成 SQL 预览，执行前必须确认 |
| `ImportService` | `application/import-service.ts` | CSV/JSON/SQL 流式导入：列映射、类型转换、错误行报告、批提交 |
| `SessionMonitor` | `application/session-monitor.ts` | 会话/锁面板，终止后端（PG `pg_terminate_backend`，MySQL `KILL`） |
| `Tunnel` | `infrastructure/ssh/tunnel.ts` | SSH 本地端口转发，供驱动连 `127.0.0.1:<port>` |

驱动端口保持小而稳：`DatabaseDriver`（查询/元数据）＋ 可选能力
`DataEditingDriver`、`TableExportDriver`、`TransactionalDriver`、`DdlDriver`（新增，
提供 `objectDdl` 与 `applyDdl`）。能力缺失时服务层抛可读错误，UI 隐藏入口。

### 3.2 模块清单（新增与改动）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `domain/driver.ts` | 扩展 | 增加 `DdlDriver`、`SessionDriver` 能力端口；`listDatabases` 已存在 |
| `domain/scope.ts` | 已交付 | scope 键与序列化，缓存键统一 `connectionId\u0000database` |
| `application/connection-service.ts` | 已交付 | `requireScopedDriver` 作用域池、`listDatabases`、`switchDatabase`，断开时释放副库池 |
| `application/console-service.ts` | 已交付 | 多控制台：`open/copy/close/list`，关闭时取消运行中查询并回滚该控制台事务 |
| `application/object-service.ts` | 已交付 | 搜索、DDL、统计；按 scope + 对象缓存 60 秒，可手动失效 |
| `application/ddl-planner.ts` | 新增 | 建表/改列/索引的结构化模型 → SQL，附风险标记 |
| `application/import-service.ts` | 已交付 | CSV/JSON 流式解析、列映射预览、分批提交（默认 1000 行）、错误行收集（最多 100 行）、可取消 |
| `application/session-monitor.ts` | 新增 | 会话列表、长事务标记、终止操作 |
| `infrastructure/postgres/*` | 扩展 | `ObjectCatalogDriver`（搜索/DDL/统计）、`TransactionalDriver` |
| `infrastructure/mysql/*` | 扩展 | 同上；编辑/导出/事务逐步补齐 |
| `infrastructure/ssh/tunnel.ts` | 新增 | `ssh2` 客户端 + 本地转发 + 生命周期 |
| `presentation/object-explorer.ts` | 重构 | 资源树升级为对象浏览器（搜索入口、按 scope 嵌套） |
| `presentation/console-panel.ts` | 新增 | 控制台标签与结果渲染的宿主侧协调 |
| `webview/src/views/*` | 新增 | Console、Objects、Import、Sessions 等视图 |

## 4. 协议 v5

信封不变：`{kind:'request', id, type, payload}`，响应 `ok/data` 或 `error{code,message}`
（错误可带 `conflictingKeys`）。新增请求分组：

| 分组 | 核心请求 | 说明 |
| --- | --- | --- |
| datasource | `connection.*` | 现有 CRUD/test/connect/disconnect，增加 `tunnel.*` |
| scope | `database.list`（已交付）、`scope.describe` | 数据库列举与作用域元信息 |
| console | `console.open/close/list`（已交付）、`query.execute`（带 `consoleId`） | 控制台与执行 |
| object | `object.search`、`object.ddl`、`object.stats`、`object.openInEditor`（已交付） | 对象搜索、DDL、统计、在编辑器打开 |
| ddl | `ddl.preview`、`ddl.apply` | 结构变更预览与执行 |
| import | `import.preview`、`import.start`、`import.cancel`（已交付） | 导入向导与后台任务；进度经 `import.progress` 事件推送 |
| session | `session.list`、`session.terminate` | 运维视图 |
| data | `data.*`、`transaction.*`、`query.explain` | 现有能力，输入统一增加可选 `database`（已交付）；`data.page` 支持 `filters` 与多列 `orderBy` |

所有输入中的 `database` 可选（缺省=连接主库），保证 0.1.x 客户端仍可工作；
`PROTOCOL_VERSION` 已升到 5。

作用域规则（D1.2 已落地）：资源树可按库嵌套展开，副库使用独立 pool 且**只读**；
写请求（`query.execute` 中的 DML、`data.commit`）在副库上被服务层拒绝，并提示
“切换连接后编辑”；事务始终绑定主库，`transaction.run` 不会带 `database`。

控制台（D2 已落地）：一个连接可开多个控制台，各自持有 SQL/结果/错误与事务状态；
会话键为 `consoleId ?? connectionId`，关闭控制台先取消其 `requestId` 再回滚其事务，
断连时按连接回滚全部控制台，标签保留并标记“需重连”。

对象浏览（D3 已落地）：`ObjectCatalogDriver` 提供搜索、DDL 与统计；表 DDL 由列定义、
主键约束与二级索引重建，视图直接取服务器定义；统计来自 `pg_total_relation_size` 与
`reltuples`（行估算可能为负，此时返回 `null`）。结果按 `scope + 对象` 缓存 60 秒，
缓存键以 scope key 开头，`invalidate(connectionId)` 可按连接清理。Webview 只拿到
DDL 文本，不能自己拼 SQL 或读目录。

## 5. 生命周期与并发

- **作用域池**：主库池常驻；副库池按需创建、空闲 5 分钟回收、连接断开/配置修改/
  删除连接时全部释放。并发上限按连接计（主库 4 + 每副库 2）。
- **控制台**：控制台只持有 scope 和执行状态，不持有连接；关闭控制台取消其运行中查询；
  显式事务绑定单一控制台，关闭时回滚。
- **后台任务**：导入/导出/DLL 预检都有 `requestId` + `AbortController`，可取消；
  结果通过事件回传进度。
- **取消语义**：SQL 用后端终止（PG `pg_terminate_backend`、MySQL `KILL QUERY`），
  写入/导入在语句之间检查信号并回滚。

## 6. 安全模型

| 风险 | 措施 |
| --- | --- |
| 凭据泄露 | SecretStorage；SSH 私钥/口令同样只进 SecretStorage；不写日志 |
| SQL 注入 | 写路径全部 `$n`/`?` 参数化；标识符白名单 + 引用（`"`/`` ` ``） |
| 危险 DDL | `DdlPlanner` 输出风险等级，UI 必须输入确认或二次弹窗；只读连接禁止 |
| 导入越权 | 目标 scope 必须处于可写连接；`INSERT` 列映射校验 NOT NULL/长度/类型 |
| 终止会话误伤 | 只允许终止本连接可见且属于当前用户的会话，除非显式开启管理员模式 |
| 隧道暴露 | 本地端口仅绑 `127.0.0.1`；隧道随连接释放；失败即关闭 |

## 7. 性能预算

- 元数据：树按需加载；对象搜索先查 `pg_class`/`information_schema` 名称索引，限 200 条。
- 结果：单页 ≤1000 行、单次响应 ≤8 MB；超出提示分页或导出。
- 导入：流式解析（`csv-parse`），默认批 1000 行，单事务可配置。
- 包体：宿主 <5 MB（按驱动懒加载）；Webview 代码分割，AG Grid 单独 chunk。
- UI：网格虚拟滚动、控制台懒挂载、避免整树重渲染。

## 8. 落地顺序

A 作用域与嵌套导航 → B 多控制台 → C 对象浏览器 → D 编辑强化 → E 导入 →
F 结构变更 → G 驱动广度与 SSH → H 运维视图。每阶段独立可发布，见
[plan.md](plan.md)；能力矩阵见 [datagrip-parity.md](datagrip-parity.md)。

## 9. 非目标

- 不实现 SQL 调试器、图形化 ER 图编辑、数据库版本管理/迁移引擎。
- 不做与 DataGrip 像素级一致的 UI；以工作流等价为准。
- 不在 Webview 内运行 SQL 解析器或驱动；不引入 ORM/查询构建器。
