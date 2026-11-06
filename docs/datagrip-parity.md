# DataGrip 功能对齐路线

用户目标：让 DataForge 具备 DataGrip 的核心工作流。完全对齐是一个多阶段工程，
本文件把 DataGrip 的能力拆成可验收的切片，按依赖顺序推进，而不是一次性重写。

## 0. 当前判断

- 已具备：连接管理（PostgreSQL / MySQL）、资源树、SQL 编辑与执行、结果网格、
  取消、数据编辑（事务化提交 + `xmin` 乐观锁）、CSV 导出、补全、格式化、
  历史、状态栏计时、EXPLAIN、显式事务会话。
- 最大缺口：**一次连接只能看到连接时指定的那个数据库**。DataGrip 的行为是
  在数据源下按数据库展开，内部为每个数据库建立独立连接。
- 结论：先做“数据库维度”（D1），再谈控制台、对象操作、导入导出等上层能力。

## 1. 数据库维度（D1）

### 1.1 已交付（0.1.3 起步）

- 资源树在连接下新增 `Databases` 节点，列出服务器上可连接的数据库
  （PostgreSQL：`pg_database` 中 `not datistemplate and datallowconn`；
  MySQL：`information_schema.schemata`，其 database 与 schema 同义）。
- 当前数据库标 `current`；点击其它数据库即“切换该连接的数据库”并重连
  （命令 `dataforge.switchDatabase`），随后刷新树。
- 驱动端口新增可选 `listDatabases?()`；不支持跨库列举的驱动退化为
  “只返回当前数据库”，调用方无需分支。

这一版是**切换**而非**嵌套展开**：PostgreSQL 不允许跨库查询，切换会重建连接池，
正在执行的查询/事务会被中断，因此必须由用户显式触发。

### 1.2 已完成：按数据库嵌套展开（D1.2，0.1.4）

目标：`Databases → <database> → Schemas → schema → Tables/Views → relation → columns`，
与 DataGrip 一致，且浏览不切换主连接。

实现要点（协议 v5，已落地）：

1. `ConnectionService` 增加作用域驱动：`requireDriver(connectionId, database?)`，
   以 `connectionId + database` 为键缓存 pool，`disconnect` / `update` / `delete`
   时一并释放；主连接池仍用于执行用户 SQL 与事务。
2. `SchemaService` 的三个缓存键加入 `database`；新增
   `database.list` 请求（`{connectionId}` → `string[]`）。
3. 协议输入统一增加可选 `database`：`QueryInput`、`ExplainInput`、
   `DataPageInput`、`DataCommitInput`、`DataExportInput`、事务四连。
4. 资源树节点携带 `database`；`editor.prefill` 的 `RelationTarget` 增加 `database`，
   工作台显示当前数据库并随查询下发。
5. 写路径默认仍绑定主连接数据库；对非主库的表，先提示“切换后编辑”再走
   `dataforge.switchDatabase`，避免 `xmin`、事务、导出语义含糊。

验收结果：展开任意数据库不改变主连接；在其中执行只读 SQL 命中正确库；断开/切换库后副库池被回收；
非主库的表在数据页显示只读原因，提交前即被拒绝并提示“切换连接后编辑”。

### 1.3 已完成：多控制台（D2，0.1.4）

目标：同一个连接可以开多个控制台，标签切换时各自保留 SQL、结果、错误与事务状态；
关闭一个控制台只影响它自己的语句和事务。

实现要点：

1. `ConsoleService` 记录 `{id, connectionId, database, title, requestId}`；
   `open/copy/list/close`，关闭时先 `queries.cancel(requestId)` 再
   `sessions.rollbackConsole(id)`，多控制台之间互不影响。
2. `QueryService` 在执行前就登记 `AbortController`（而不是等拿到连接池），
   否则“池还没拿到就被关闭”的控制台会漏取消。
3. `QuerySessionService` 的会话键从 `connectionId` 改为 `consoleId ?? connectionId`，
   断连时按连接回滚全部控制台，`rollbackConsole` 只回滚一个。
4. Webview 的 store 改为“标签数组 + 活动标签”，`sql/result/error/running/transaction*`
   都是活动标签的派生值；切连接只重绑当前标签，标签栏显示运行中/事务中/错误/断开状态。

验收结果：两个控制台可同时运行，关闭其一只取消它自己的请求；关闭带事务的控制台会回滚；
未知控制台返回 `not_found`；断连后标签保留并显示“需重连”。

### 1.4 已完成：对象浏览与搜索（D3，0.1.4）

目标：不再只能顺着树点，按名字找对象、直接看 DDL、看表有多大。

实现要点：

1. 驱动端口 `ObjectCatalogDriver`（`searchObjects?` / `objectDdl` / `objectStats`），
   PostgreSQL 用 `pg_get_viewdef`、`pg_get_indexdef`、`pg_total_relation_size`、`reltuples`；
   MySQL 用 `SHOW CREATE TABLE|VIEW` 与 `information_schema`。
2. `ObjectService` 负责搜索（限 200，上限 500，可截断）、DDL 与统计，
   按 `scope + 对象` 缓存 60 秒，`invalidate()` 可在切换库/刷新时清空。
3. 树节点右键 `Show DDL`、视图标题 `Search Objects`（宿主 QuickPick）打开同一面板；
   Webview 面板只读展示、可复制、可 `object.openInEditor` 在编辑器打开。
4. DDL 是重建而非原样回放：表由列 + 主键约束 + 二级索引拼出，分区表附 `partition by`
   并注明分区未复现；视图/物化视图直接用服务器定义。

验收结果：搜索能命中表与视图并标注 kind；表 DDL 含 `PRIMARY KEY` 与索引；
统计返回总大小、行估算与二级索引；缺失对象 `not_found`；同一对象第二次读取命中缓存。

### 1.5 已完成：数据编辑器强化（D4，0.1.4 开发中）

目标：把“能改数据”提升到日常可用的手感，不引入自研网格。

实现要点：

1. 过滤是服务端 `where`：`data.page` 新增 `filters`（最多 10 条），
   `buildFilters` 白名单列名、按操作符绑定参数，`contains` 绑定 `%value%`；
   分页与 `count(*)` 使用同一条件，序号连续（`limit $N offset $N+1`）。
2. 多列排序：AG Grid 的 `sortIndex` 映射为 `DataSortDto[]`，翻页/过滤后保持。
3. 批量粘贴：粘贴 TSV（无制表符时按逗号），按可编辑列顺序追加为待提交行，
   按列类型转数字/布尔，`NULL` 与空单元格写 null。
4. 列级规则：生成列（PostgreSQL `attgenerated`、MySQL `extra like '%GENERATED%'`）
   只读并标注 `· computed`；主键列在已有行上仍不可改。
5. JSON 预览：双击 JSON/数组单元格弹出格式化面板（编辑仍走单元格）。
6. 页脚常驻行数、页码与跳页输入。

验收结果：单元测试覆盖过滤 SQL 与参数编号、`is null` 拒绝携带值、驱动收到过滤条件；
真实 PostgreSQL 集成验证过滤后 `totalRows` 与行内容；浏览器演示过滤即时生效、
粘贴生成待提交行、生成列不可编辑。

### 1.6 已完成：CSV/JSON 导入（D5 的导入部分，0.1.4 开发中）

目标：导入不把整个文件读进内存，错误能定位到行。

实现要点：

1. 宿主选文件并持有句柄：`import.preview` 在本机弹出文件选择器，只读前 256 KB
   做样本（CSV 解析 `csv-parse`，支持 BOM、`,`/`;`/Tab、首行表头开关），返回
   不透明 `token`；界面拿不到路径，也无法让 webview 直接读文件。
2. 映射预览：样本下发后逐列选择目标列（可忽略），默认按表头大小写不敏感匹配；
   打开前校验目标列类型、NOT NULL 与默认值，缺少必填来源时直接拒绝。
3. 分批提交：流式读取按 `batchSize`（默认 1000，上限 5000）逐批走
   `DataEditorService.commit`，每批是一个事务；某批失败即停止并回滚该批，
   报告前 100 条错误（行号 + 原因）。
4. 进度与取消：`import.progress` 事件在每批后推送（已处理/已写入/失败），
   取消按请求 id 生效，已提交批次保留、未提交批次不留半行。

验收结果：9 个单元用例覆盖类型转换、默认映射、取消与过期 token；真实 PostgreSQL
集成验证按批导入 3 行、坏行整批回滚且表仍为空；浏览器演示选文件、映射、导入后
toast「Imported 3 row(s) into public.orders.」。SQL 文件导入与“导出可选列/分隔符”
仍未做。

### 1.7 已完成：结构变更（D6 的 DDL 部分，0.1.4 开发中）

目标：结构变更先生成 SQL 预览再执行，危险操作必须二次确认。

实现要点：

1. 计划即数据：webview 只发送结构化 `DdlPlanDto`（建表/加列/改列/建索引/删表），
   宿主校验标识符、类型与默认值后由 PostgreSQL 方言生成带引用的 SQL，不接受原始 SQL。
2. 风险分级与确认：建表 `safe`；加列/索引/改默认值 `caution`；删表、改类型、加 NOT NULL
   为 `dangerous`。删表必须输入表名，其余危险操作输入 `CONFIRM`；确认文本不符即拒绝。
3. 守卫：MySQL 暂不支持；只读连接、存在打开事务时拒绝并说明原因；执行在一个事务内，
   失败回滚；成功后失效 schema 缓存。
4. 预览面板：逐条 SQL + 风险徽标 + 说明，支持复制、在编辑器打开（只读文档）和执行；
   变更命中当前打开的表时自动刷新数据页。
5. schema diff（简版）：`schema.diff` 比较两个 scope 的表/视图增删与类型变化，排序返回。

验收结果：单元测试覆盖 5 种计划、风险与确认规则、SQL 渲染（含 `if not exists`/
`if exists`、默认值转义）；真实 PostgreSQL 集成验证建表→加列→建索引→删表、
改列默认值与 NOT NULL（含空值失败回滚）、NOT NULL 新列在已有行时整批失败；
浏览器演示删表预览、输入表名解锁 Apply 与执行 toast。

已知缺口：schema diff 没有界面入口；约束编辑与重命名未做；MySQL 结构变更未开启。

### 1.8 已完成：SSH 隧道与只读 SQL Server（0.1.4 开发中）

目标：验证端口抽象能容纳第三种协议与网络中间层，同时不把 SSH 细节泄进驱动。

实现要点：

1. SSH 隧道：`ssh2` 连接跳板机（密码或私钥 + passphrase），本地 `127.0.0.1:0`
   端口转发到数据库；连接服务把 profile 的 host/port 替换为隧道端点，驱动只看到
   普通 host/port。同一连接的全部作用域池复用一条隧道，断开/删除/失败都会关闭。
2. SecretStorage：密码、SSH 口令、私钥口令分三个键存放；切换认证方式会删除陈旧口令，
   Webview 永远拿不到已保存的密钥。
3. 连接对话框：SSH 开关与字段校验（host/port/user/auth/key path/passphrase）；
   SQL Server 预设自动勾选只读并填 1433。
4. SQL Server 驱动：仅实现 `DatabaseDriver`；`isReadOnlySql` 在打开 socket 前拒绝
   非 SELECT/CTE；查询支持取消与请求超时；元数据来自 `sys.databases` 与
   `INFORMATION_SCHEMA`。
5. 能力矩阵：连接摘要新增 `capabilities`，由角色接口推导；Webview 禁用 Data 标签、
   导入/导出、Schema 与事务工具条，SQL Server 只保留查询、资源树元数据与数据库列表。

验收结果：隧道 5 个单测（配置、转发、握手失败、幂等关闭）与连接服务 3 个单测
（端点替换、能力矩阵、失败清理）；SQL Server 3 个单测验证只读守卫；浏览器验证
SQL Server 预设、SSH 字段切换与私钥/passphrase 表单。全量 200 个单元测试通过
（无 PG/MySQL 容器时跳过 43 个集成用例）。

已知缺口：没有真实 SQL Server 实例，集成测试尚未实际运行；私钥路径还是文本框；
SSL 证书校验只有 `disable/require/verify-full` 三档，未做证书文件选择；SQLite 仍推迟。

### 1.9 已完成：运维视图（D8，0.1.4 开发中）

目标：不离开编辑器就能看到“谁在跑什么、哪条最慢、计划长什么样”。

实现要点：

1. 会话监视：`SessionDriver` 端口统一 PostgreSQL `pg_stat_activity` 与 MySQL
   `information_schema.processlist` 的差异，服务层过滤自身 backend、标记超过 60 秒的
   `longRunning`，并返回当前角色。
2. 终止会话：必须显式确认，且只允许终止与当前角色相同的会话；PostgreSQL 使用
   `pg_terminate_backend($1)`，MySQL 使用文本 `KILL CONNECTION <id>`，失败映射为可读错误。
3. 执行计划：`EXPLAIN (FORMAT JSON)` 被解析为 `ExplainPlanNodeDto` 树，
   `PlanTree.vue` 递归显示节点类型、关系/索引、代价、计划行数与实际耗时；原始 JSON 保留。
4. 慢查询：`dataforge.showSlowQueries` 从成功历史中取耗时前 50 条，选中后替换编辑器
   或预填工作台，复用历史命令的跳转方式。
5. 能力矩阵：`sessions` 能力由驱动角色接口推导，SQL Server 等驱动隐藏会话入口。

验收结果：计划解析 4 个单测、会话监视 6 个单测（确认/归属/缺失/无能力）、路由 3 个单测；
真实 PostgreSQL 集成测试用第二个连接执行 `pg_sleep(30)`，验证列表、拒绝未确认终止、
确认后终止并从 `pg_stat_activity` 消失；全量 251 个测试通过（PG 容器，跳过 6 个）。

已知缺口：锁视图、阻塞链与连接诊断未做；没有 `EXPLAIN ANALYZE` 的独立入口（沿用查询结果）。

## 2. 之后的切片（按依赖排序）

| 阶段 | 能力 | 关键交付 | 依赖 |
| --- | --- | --- | --- |
| D4 | 数据编辑器强化 | 已完成（过滤、多列排序、粘贴、生成列、JSON 预览、跳页）；keyset 分页待补 | —— |
| D5 | 导入导出 | CSV/JSON/SQL 导入（映射预览、错误行报告）、导出可选列/分隔符/编码 | D4（导入已落地，SQL 导入与导出选项待补） |
| D6 | 结构与变更 | 新建/修改表对话框、索引/约束编辑、预览 SQL 后执行、简单 schema diff | D3（建表/加列/改列/索引/删表与预览已落地；diff 无 UI、约束编辑待补） |
| D7 | 数据源广度 | SQL Server（只读）、SSH 隧道与能力矩阵已落地；SQLite、SSL 证书管理待补 | D1.2 |
| D8 | 运维体验 | 会话监视/终止、执行计划树、慢查询入口已落地；锁视图与连接诊断待补 | D2 |

## 3. 原则

- **不追 UI 复刻，追工作流等价**：DataForge 的界面是 VS Code 原生树 + Webview，
  不引入 Monaco 重写编辑器，继续复用 VS Code 语言能力。
- **协议先行**：任何跨边界的新能力先加 `shared/protocol.ts` 的类型与 Zod 校验，
  再实现宿主服务，最后接 Webview。
- **危险操作必须显式确认**：跨库切换、批量提交、DDL、终止会话都要二次确认。
- **每批 ≤3 个文件**，每批结束跑 `type-check`、`test:unit`、`lint`。
- **能力缺失要可见**：不支持的驱动或对象必须给出可读原因，而不是空节点。

## 4. 里程碑

- M6 = D1.2 完成（按库嵌套浏览）。
- M7 = D3（已完成）+ D4（编辑强化），此时对日常“看数据、改数据”已接近 DataGrip。
- M8 = D2 + D5 + D6（控制台、导入导出、结构变更）。
- M9 = D7 + D8（多驱动与运维体验）。
