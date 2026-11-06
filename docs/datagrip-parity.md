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

### 1.2 待完成：按数据库嵌套展开（D1.2）

目标：`Databases → <database> → Schemas → schema → Tables/Views → relation → columns`，
与 DataGrip 一致，且浏览不切换主连接。

实现要点（对应协议 v5）：

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

验收：展开任意数据库不改变主连接；在其中执行 SQL 命中正确库；切换库后池被回收；
非主库的表点击“编辑数据”会引导切换而不是静默失败。

## 2. 之后的切片（按依赖排序）

| 阶段 | 能力 | 关键交付 | 依赖 |
| --- | --- | --- | --- |
| D2 | 查询控制台与会话 | 每个连接多控制台（标签）、会话内保留结果、取消与重连隔离 | D1.2 |
| D3 | 对象浏览与搜索 | 全库对象搜索、DDL 查看（`pg_get_*def`）、依赖/引用、表大小与行数统计 | D1.2 |
| D4 | 数据编辑器强化 | 列级编辑、批量粘贴、条件过滤、排序持久化、行数统计、二进制/JSON 预览 | —— |
| D5 | 导入导出 | CSV/JSON/SQL 导入（映射预览、错误行报告）、导出可选列/分隔符/编码 | D4 |
| D6 | 结构与变更 | 新建/修改表对话框、索引/约束编辑、预览 SQL 后执行、简单 schema diff | D3 |
| D7 | 数据源广度 | SQLite、SQL Server、SSH 隧道、SSL 证书、驱动级能力矩阵 | D1.2 |
| D8 | 运维体验 | 执行计划可视化、慢查询面板、会话/锁查看与终止、连接诊断 | D2 |

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
- M7 = D3 + D4（对象浏览 + 编辑强化），此时对日常“看数据、改数据”已接近 DataGrip。
- M8 = D2 + D5 + D6（控制台、导入导出、结构变更）。
- M9 = D7 + D8（多驱动与运维体验）。
