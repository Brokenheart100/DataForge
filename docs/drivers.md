# DataForge 驱动开发指南

DataForge 把数据库访问收敛在一组领域端口上，宿主与 Webview 都只认识 DTO。
新增一种数据库时**只需要实现端口**，不需要改动 IPC、界面或服务层。

## 1. 端口一览

`extension/src/domain/driver.ts` 定义了全部端口，按能力拆分，互不依赖：

| 端口 | 用途 | 谁在用 |
| --- | --- | --- |
| `DatabaseDriver` | 连接测试、执行 SQL、读取模式/表/列 | 所有数据库，必需 |
| `DataEditingDriver` | 分页读取 + `countRows` + 批量参数化写入（单客户端事务） | 数据编辑页 |
| `TableExportDriver` | 游标分批导出整表 | CSV 导出 |
| `TransactionalDriver` | 打开显式事务会话（`BEGIN`/`COMMIT`/`ROLLBACK`） | 事务工具条 |

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

## 4. 两种驱动已实现的差异

| 能力 | PostgreSQL | MySQL |
| --- | --- | --- |
| 查询 / 元数据 | ✅ | ✅ |
| 取消 | ✅ `pg_terminate_backend` | ✅ `KILL QUERY`，被中断的 `SLEEP()` 会返回半成品结果，驱动以 AbortSignal 为准判为 cancelled |
| 语句超时 | ✅ `statement_timeout` | ✅ `max_execution_time`（仅约束 SELECT，逐连接懒设置） |
| 数据编辑 | ✅ `xmin` 乐观锁 | ⬜ 尚未实现（`DataEditingDriver`） |
| CSV 导出 | ✅ `pg-cursor` 分批 | ⬜ 尚未实现（`TableExportDriver`） |
| 显式事务 | ✅ 专用客户端会话 | ⬜ 尚未实现（`TransactionalDriver`） |
| 标识符引用 | `"` | `` ` `` |

## 5. 测试夹具

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

夹具表名带随机后缀，`beforeAll` 建表、`afterAll` 删表，避免并行跑测时互相干扰。

## 6. 什么时候才做「方言抽象」

现在**没有**公共 SQL 方言层：SQL 构造器在 PostgreSQL 目录下，MySQL 只做查询与元数据。
只有当第二个驱动真的需要写入/分页，且两者的 SQL 差异被证明重复时，才把
`sql-builder` 提取为按方言注入的模块。提前抽象只会制造无用的间接层。
