# DataForge 驱动开发指南

DataForge 把数据库访问收敛在一组领域端口上，宿主与 Webview 都只认识 DTO。
新增一种数据库时**只需要实现端口**，不需要改动 IPC、界面或服务层。
当前内置 PostgreSQL、MySQL 与只读的 SQL Server 三种驱动。

## 1. 端口一览

`extension/src/domain/driver.ts` 定义了全部端口，按能力拆分，互不依赖：

| 端口 | 用途 | 谁在用 |
| --- | --- | --- |
| `DatabaseDriver` | 连接测试、执行 SQL、读取模式/表/列 | 所有数据库，必需 |
| `DataEditingDriver` | 分页读取 + `countRows` + 批量参数化写入（单客户端事务） | 数据编辑页 |
| `TableExportDriver` | 游标分批导出整表 | CSV 导出 |
| `TransactionalDriver` | 打开显式事务会话（`BEGIN`/`COMMIT`/`ROLLBACK`） | 事务工具条 |
| `DdlDriver` | 在一个事务内执行已生成的 DDL 语句 | 结构变更面板 |
| `ObjectCatalogDriver` | 对象搜索、DDL 与统计 | 对象浏览 |

只有 `DatabaseDriver` 是必需能力，其余都是**可选角色接口**：能力缺席时对应功能会返回
`internal` 错误（例如「This connection does not support data editing yet.」），而不是让宿主崩溃。
能力检测使用 `isDataEditingDriver` / `isTransactionalDriver` / `isTableExportDriver`
这类类型守卫，规则统一是「方法存在即可用」。

## 2. 新增驱动的最小步骤

以已实现的 PostgreSQL（`infrastructure/postgres`）与 MySQL（`infrastructure/mysql`）为参照：

1. **协议**：在 `shared/protocol.ts` 的 `ConnectionKind` 里加入新的 kind 字符串。
2. **领域默认值**：在 `extension/src/domain/connection.ts` 的 `KIND_DEFAULTS` 补齐
   `{ port, database, user }`，`createProfile` 会据此生成默认连接参数。
3. **驱动实现**：新建 `extension/src/infrastructure/<kind>/<kind>-driver.ts`，
   `implements DatabaseDriver`，并把 `readonly kind` 写成新的 kind。
4. **组合根**：在 `extension/src/extension.ts` 的 `createDriver` 中按
   `config.profile.kind` 返回对应实现；这里是唯一知道具体类的地方。
5. **界面预设**：在 `webview/src/components/ConnectionDialog.vue` 的 `KIND_PRESETS`
   增加一项，用户才能在新建连接时选中它。
6. **测试**：单元测试覆盖 SQL 构造/映射纯函数；集成测试用真实容器，通过
   `DATAFORGE_TEST_<KIND>` 环境变量开启，未设置时整组跳过。

只读驱动（如 SQL Server）只需实现 `DatabaseDriver`：在 `query` 打开连接前用一个
`assertReadOnly` 守卫拒绝非 SELECT/CTE 语句，能力矩阵会根据角色接口自动推导出
`dataEditing/exportCsv/transactions/schemaChanges = false`，Webview 据此隐藏入口。

## 3. 实现约定

- **永远不要拼接用户输入**。标识符走各自的 `quoteIdentifier`（PostgreSQL 用 `"`，
  MySQL 用反引号），值一律使用占位符（`$1` / `?`）。
- **结果映射**：单元格值统一走 `infrastructure/cells.ts` 的 `toCellValue`，
  保证 Webview 收到 `string | number | boolean | null`；二进制转 `\x<hex>`，日期转 ISO。
- **错误映射**：驱动内部错误必须转换成 `DataForgeError`，并区分
  `connection_failed` / `query_failed` / `cancelled`，同时用 `redactSecrets` 去掉密码。
- **取消**：`DriverQueryInput.signal` 触发时，必须真正中断服务端语句
  （PostgreSQL 用独立连接发 `pg_terminate_backend`，MySQL 用 `KILL QUERY`），
  并保证被终止的后端不会回到连接池。
- **分页**：`selectPage` 只返回 `limit` 行，`totalRows` 单独计数；只有可编辑的堆表才带
  `xmin` 之类的版本列（PostgreSQL），视图不追加。
- **写入**：`applyMutations` 必须在**同一个客户端**上 `BEGIN → 语句 → COMMIT`，
  影响行数为 0 的更新/删除视为冲突，抛 `DataConflictError` 并整批回滚。

## 4. 三种驱动已实现的差异

| 能力 | PostgreSQL | MySQL | SQL Server（只读） |
| --- | --- | --- | --- |
| 查询 / 元数据 | ✅ | ✅ | ✅ `tedious`，`INFORMATION_SCHEMA` + `sys.databases` |
| 取消 | ✅ `pg_terminate_backend` | ✅ `KILL QUERY`，被中断的 `SLEEP()` 会返回半成品结果，驱动以 AbortSignal 为准判为 cancelled | ✅ `request.cancel()`，可能返回部分结果，同样以 AbortSignal 为准 |
| 语句超时 | ✅ `statement_timeout` | ✅ `max_execution_time`（仅约束 SELECT，逐连接懒设置） | ✅ `requestTimeout`（`SELECT` 与元数据都受限） |
| 数据编辑 | ✅ `xmin` 乐观锁 | ⬜ 尚未实现（`DataEditingDriver`） | ⬜ 只读驱动 |
| CSV 导出 | ✅ `pg-cursor` 分批 | ⬜ 尚未实现（`TableExportDriver`） | ⬜ |
| 显式事务 | ✅ 专用客户端会话 | ⬜ 尚未实现（`TransactionalDriver`） | ⬜ |
| DDL | ✅ `DdlDriver` | ⬜ | ⬜ |
| 标识符引用 | `"` | `` ` `` | `[ ]`（只读查询由服务器解析，驱动不拼写标识符） |

## 5. 只读驱动：SQL Server

- 配置：`server`、`port`（默认 1433）、`database`（默认 `master`）、`user`、密码；
  `ssl: 'disable' | 'require' | 'verify-full'` 映射到 `encrypt` 与
  `trustServerCertificate`。若启用 SSH 隧道，连接服务会把 host/port 换成隧道回环地址。
- 只读守卫是纯函数 `isReadOnlySql`：去掉 `--` 与 `/* */` 注释后，首个关键字必须是
  `select` 或 `with`，且不允许 `into`。守卫在建立 socket 之前执行，失败返回
  `invalid_request`，不会触发网络连接。
- 每次请求新建一条短连接，请求结束即关闭；没有连接池，避免长期占用服务端会话。
- 元数据：数据库来自 `sys.databases`（排除系统库），模式来自
  `information_schema.schemata`，表/视图与列来自 `information_schema` 并关联主键约束；
  列类型经 `displayType` 组合 length/precision/scale。
- 没有真实 SQL Server 的 CI 会跳过集成测试（`DATAFORGE_TEST_MSSQL`），单元测试覆盖
  只读判定、语句拒绝与结果映射。

## 6. SSH 隧道

`infrastructure/ssh/tunnel.ts` 只做本地端口转发，不理解数据库协议：

1. 用 `ssh2` 连接跳板机（密码或私钥 + passphrase），`readyTimeout` 取
   `dataforge.connectTimeoutMs`（默认 10s）。
2. 在 `127.0.0.1:0` 起一个本地 TCP server，每个 socket 通过
   `client.forwardOut(..., targetHost, targetPort)` 转发到数据库真实地址。
3. 连接服务拿到的隧道端点 `{host, port}` 会替换 profile 的 host/port，因此驱动完全
   不需要知道 SSH 的存在；同一连接的所有作用域池复用同一条隧道。
4. 断开连接、删除连接、`dispose` 或连接失败都会关闭 server 与 SSH 客户端；
   `close()` 幂等，先销毁 socket 再 `server.close()`，最后 `client.end()`。
5. 口令与私钥口令分别存入 SecretStorage 的
   `dataforge.connection.<id>.ssh-password|ssh-passphrase`；切换认证方式时会删除旧密钥。

## 7. 测试夹具

```bash
# PostgreSQL
docker run -d --rm --name dataforge-pg -e POSTGRES_PASSWORD=forge_test \
  -e POSTGRES_DB=forge -p 5433:5432 postgres:17-alpine
DATAFORGE_TEST_PG="postgres://postgres:forge_test@127.0.0.1:5433/forge" \
  npm run test:unit --workspace extension

# MySQL
docker run -d --rm --name dataforge-mysql -e MYSQL_ROOT_PASSWORD=forge_test \
  -e MYSQL_DATABASE=forge -p 3307:3306 mysql:8.4
DATAFORGE_TEST_MYSQL="mysql://root:forge_test@127.0.0.1:3307/forge" \
  npm run test:unit --workspace extension
```

SQL Server 目前没有可用的测试实例，驱动只用单元测试验证只读守卫与映射；
接入真实服务器时按上面的约定增加 `DATAFORGE_TEST_MSSQL` 集成用例。

夹具表名带随机后缀，`beforeAll` 建表、`afterAll` 删表，避免并行跑测时互相干扰。

## 6. 什么时候才做「方言抽象」

现在**没有**公共 SQL 方言层：SQL 构造器在 PostgreSQL 目录下，MySQL 只做查询与元数据。
只有当第二个驱动真的需要写入/分页，且两者的 SQL 差异被证明重复时，才把
`sql-builder` 提取为按方言注入的模块。提前抽象只会制造无用的间接层。
