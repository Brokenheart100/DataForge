# DataForge 计划（DataGrip 对齐版）

目标：把 DataForge 从“能连库、能跑 SQL、能改数据”推进到 DataGrip 的核心工作流。
能力矩阵与差异清单见 [datagrip-parity.md](datagrip-parity.md)，目标架构见
[architecture.md](architecture.md)，依赖取舍见 [dependencies.md](dependencies.md)。

## 1. 现状（0.1.4 开发中）

| 已交付 | 说明 |
| --- | --- |
| 数据源与连接 | PostgreSQL / MySQL，测试、增删改、连接/断开，SecretStorage 存密码 |
| 资源树 | 连接 → Databases → 库 → Schemas → 表/视图组 → 表/视图 → 列（类型、PK、NOT NULL、默认值）；副库只读浏览 |
| 数据库切换 | `Databases` 节点列出服务器数据库，点击即切换连接并重连（0.1.3） |
| SQL 与结果 | 执行全部/选中、取消、10 000 行上限、200 行网格分页、错误码展示 |
| 数据编辑 | 事务化批量提交、`xmin` 乐观锁、无主键/视图只读、冲突整批回滚 |
| 导出 | CSV 流式导出（`pg-cursor`，每批 1000 行），宿主选路径 |
| 编辑器能力 | 补全（复用 schema 缓存）、格式化、历史 200 条、EXPLAIN、状态栏耗时 |
| 事务 | 显式 `BEGIN/COMMIT/ROLLBACK`，关闭面板/断开连接自动回滚 |
| 控制台 | 每个连接多个标签页，各自保留 SQL 与结果；关闭即取消运行中的查询并回滚该控制台的事务（0.1.4） |
| 工程 | CI（双 Node + PG/MySQL service）、Release、Marketplace `dataforge.dataforge-ide` |

## 2. 版本节奏

| 版本 | 主题 | 出口标准 |
| --- | --- | --- |
| 0.2 | 作用域与多控制台（A、B） | 任意库可展开浏览；控制台可并行、互不干扰 |
| 0.3 | 对象浏览器（C） | 全库搜索、DDL、表统计可用 |
| 0.4 | 编辑强化与导入（D、E） | 过滤/粘贴/列编辑；CSV/JSON 导入带错误报告 |
| 0.5 | 结构变更（F） | 建表/改列/索引可预览并执行，危险操作需确认 |
| 0.6 | 驱动广度与 SSH（G） | SQLite 或 SQL Server 之一落地；SSH 隧道可用 |
| 1.0 | 运维与打磨（H） | 会话/锁面板；性能与可访问性达标 |

## 3. 工作原则

- 每批 **≤3 个文件**；先协议后服务，最后接 UI；每批结束跑
  `type-check` + `test:unit` + `lint`。
- 能力缺失必须给出可读原因；不允许空节点或静默失败。
- 危险操作（DDL、批量提交、跨库切换、终止会话）必须显式确认。
- 写路径一律参数化 + 标识符引用；不引入 SQL 解析器或 ORM。
- 完成一项就勾选一项；无法完成时在条目后写阻塞原因，而不是留空。

## 4. 阶段 A：作用域与嵌套导航（D1.2）

状态：✅ 实现完成（协议 v5，待发布 0.1.4）。

目标：`Databases → 库 → Schemas → 表/视图 → 列` 与 DataGrip 一致，浏览不切换主连接。

批次：

1. `shared/protocol.ts`（输入加可选 `scope`、`database.list` DTO）、`domain/scope.ts`（新）
2. `application/connection-service.ts`（scope 池：主库常驻、副库按需、统一释放）
3. `application/schema-service.ts`（缓存键加 scope）、`presentation/message-router.ts`
4. `presentation/connections-tree.ts`（嵌套节点）、`presentation/workbench-panel.ts`（`RelationTarget` 加 scope）
5. `webview/src/lib/host.ts`、`webview/src/stores/workbench.ts`、`webview/src/App.vue`
6. 测试与文档（集成测试 + `architecture.md` 同步）

### 4.1 Todo List

- [x] 协议：新增可选 `database` 与 `database.list`，`PROTOCOL_VERSION` 升到 5
- [x] `domain/scope.ts`：scope 键、序列化、缓存键工具
- [x] `ConnectionService`：`requireScopedDriver(connectionId, database?)` + 作用域池缓存与释放
- [x] `SchemaService`：`listSchemas/listRelations/listColumns` 接受 database
- [x] 资源树：`Databases → 库 → Schemas → …`，主库标记 `current`
- [x] `RelationTarget` 携带 `database`，工作台随查询/编辑请求下发
- [x] 副库为只读浏览；编辑与提交均给出“切换连接后编辑”的明确提示
- [x] 集成测试：同连接两库元数据互不串扰；副库写入被拒；切换/断开释放旧池

## 5. 阶段 B：多控制台

目标：每个连接可开多个控制台，标签切换，各自保留 SQL 与结果；关闭即取消并回滚事务。

批次：`application/console-service.ts`（新）→ 协议 `console.*` 与 router →
面板标签与 `webview` store → 测试。

状态：✅ 实现完成（协议 `console.*`，待发布 0.1.4）。

### 5.1 Todo List

- [x] `ConsoleService`：`open/copy/close/list`、绑定连接与库、记录运行中的 request id
- [x] 协议：`console.open/list/close`；`query.execute` 与事务请求携带 `consoleId`
- [x] 面板：标签栏 + 每标签状态（运行中/事务中/有错误/连接已断开）
- [x] 关闭控制台：先 `query.cancel` 取消运行中语句，再 `rollbackConsole` 回滚其事务
- [x] 重连/切库时控制台保留，切回时按需 `console.open` 重新绑定，旧句柄异步关闭
- [x] 单测：并发两个控制台互不取消；关闭只取消自己的请求并调用 `rollbackConsole`（4 个用例）

## 6. 阶段 C：对象浏览器

目标：不再只有树；支持按名称搜索、查看 DDL、看表大小/行数/索引、跳转定义。

批次：`application/object-service.ts` + 驱动端口 `objectDdl/objectStats` →
PostgreSQL 实现 → 树搜索与 DDL 面板 → 测试。

### 6.1 Todo List

- [ ] `DdlDriver` 端口：`objectDdl(scope, kind, name)`、`objectStats`
- [ ] PostgreSQL：`pg_get_*def` 读取 DDL，`pg_total_relation_size`/`reltuples`
- [ ] MySQL：`SHOW CREATE TABLE` 与 `information_schema.tables`
- [ ] `object.search`：前缀/模糊搜索，限 200 条，带 kind 图标
- [ ] Webview DDL 面板：只读高亮、复制、在编辑器中打开
- [ ] 缓存：按 scope + 对象做 TTL 缓存，失效策略可手动刷新

## 7. 阶段 D：数据编辑强化

目标：接近 DataGrip 的表格编辑体验（不引入自研网格）。

批次：`webview/src/stores/data-editor.ts` → 过滤/排序持久化 → 粘贴与列编辑 → 测试。

### 7.1 Todo List

- [ ] 过滤条件（列 + 操作符 + 值）下发服务端 `where` 参数化
- [ ] 排序多列、跨页保持；分页游标（keyset）在 10 万行以上启用
- [ ] 批量粘贴：从剪贴板按行列填充，标记为待提交
- [ ] 列级编辑：只读列、生成列、二进制列禁用并给原因
- [ ] JSON/数组单元格预览与格式化
- [ ] 行数统计与“跳到行”能力

## 8. 阶段 E：导入

目标：CSV/JSON 流式导入，列映射预览、类型转换、错误行报告、可取消。

批次：`application/import-service.ts`（`csv-parse`）→ 协议与向导 → 测试。

### 8.1 Todo List

- [ ] 流式解析，支持分隔符/编码/表头推断
- [ ] 映射预览：目标列、类型、NOT NULL 校验、默认值
- [ ] 分批提交（默认 1000 行/批），失败整批回滚并报告前 100 条错误
- [ ] 进度事件 + 取消（`AbortController`）
- [ ] 导入 SQL 文件（可选，仅语句分隔与执行）

## 9. 阶段 F：结构变更

目标：建表/加列/改类型/索引的可视化编辑，先生成 SQL 预览再执行。

批次：`application/ddl-planner.ts` → 协议与预览 UI → 驱动 `applyDdl` → 测试。

### 9.1 Todo List

- [ ] `DdlPlanner`：结构化模型 → SQL（引用标识符、按方言）
- [ ] 风险分级：DROP/改类型/加 NOT NULL 标红，需输入确认
- [ ] 预览面板：可复制、可在编辑器中执行
- [ ] 只读连接与事务中禁止 DDL，给出原因
- [ ] schema diff（简版）：两 scope 间对象差异列表

## 10. 阶段 G：驱动广度与 SSH

目标：第三个驱动落地 + SSH 隧道，验证端口抽象。

批次：`infrastructure/ssh/tunnel.ts` → 连接配置与 SecretStorage → SQLite 或 SQL Server 适配器 → 测试与文档。

### 10.1 Todo List

- [ ] SSH 隧道：本地转发、密钥/口令进 SecretStorage、断开即关闭
- [ ] 连接对话框：隧道开关与字段校验
- [ ] 第三个驱动：只读查询 + 元数据 + 能力矩阵声明
- [ ] 能力矩阵 UI：按驱动隐藏不支持的操作
- [ ] `docs/drivers.md` 更新为新驱动步骤

## 11. 阶段 H：运维视图

目标：会话/锁面板，慢查询与执行计划可视化。

### 11.1 Todo List

- [ ] `SessionMonitor`：`pg_stat_activity` / `information_schema.processlist`
- [ ] 终止会话（确认 + 权限校验）
- [ ] 执行计划可视化（JSON → 树/表）
- [ ] 慢查询入口：历史按耗时排序并跳转

## 12. 工程化待办

- [x] `.gitignore` 覆盖产物与临时目录
- [x] CI + Release 工作流（双 Node、双数据库 service）
- [x] E2E 冒烟（DemoTransport）
- [ ] `npm audit --omit=dev` 收敛（当前 17 moderate，含 mysql2 传递依赖）
- [ ] 性能与可访问性清单（键盘、对比度、焦点）、大结果压测
- [ ] 关闭工作台前的未提交变更提示
- [ ] 按驱动懒加载，把宿主包体压到 5 MB 内
- [ ] Webview 代码分割（AG Grid 独立 chunk）

## 13. 验收总表

| 能力 | 验收方式 |
| --- | --- |
| 作用域 | 同连接两库元数据互不串扰；切换后旧池释放；查询命中正确库 |
| 控制台 | 两个控制台并发执行互不取消；关闭回滚事务 |
| 对象 | 搜索限 200 条；DDL 与 psql 输出一致；统计随刷新更新 |
| 编辑 | 冲突整批回滚；过滤/排序生效于服务端；粘贴可撤销 |
| 导入 | 10 万行 CSV < 60 s；错误行可定位；取消后无残留半批数据 |
| DDL | 预览 SQL 可直接执行；危险操作必须确认 |
| 运维 | 会话列表准确；终止只影响目标连接 |

## 14. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 作用域重构面大 | 影响所有元数据与查询 | 分 6 批、每批可独立验证；旧请求缺省主库保持兼容 |
| 多控制台状态膨胀 | 内存与渲染压力 | 每控制台只保留最近一次结果；关闭释放；Pinia 有界 |
| 导入类型推断错误 | 数据污染 | 预览必须人工确认；失败整批回滚；错误行报告 |
| DDL 不可回滚 | 结构损坏 | 预览 + 确认 + 事务内执行（PG 支持的事务性 DDL） |
| 第三个驱动拖慢节奏 | 版本延期 | SQLite 用 WASM 方案或推迟到 0.7；优先 SSH + SQL Server 评估 |
