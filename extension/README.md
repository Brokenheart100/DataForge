# DataForge

A neo-brutalist database IDE inside VS Code. Phase 1 covers the full
connection-to-results loop; Phase 2 adds a data editor and CSV export; Phase 3
adds completion, formatting, history, EXPLAIN and explicit transactions; Phase 4
adds a MySQL adapter behind the same driver ports:

- **Connections** — store PostgreSQL connection profiles, test them, connect and
  disconnect from the DataForge sidebar or the workbench.
- **SSH tunnel** — connect through a jump host with a password or private key;
  forwarding is bound to a loopback port and the tunnel closes with the
  connection. SSH secrets live in VS Code SecretStorage.
- **SQL Server (read-only)** — test the connection, browse databases, schemas,
  tables, views and columns, and run `SELECT`/`WITH` statements. Writes are
  rejected before a socket is opened, and the UI hides editing actions for
  drivers that do not support them.
- **Schema browser** — lazily expand a connection into databases, then schemas,
  tables and views, then columns with types, primary keys, nullability and
  defaults. Extra databases open read-only; switching the connection's own
  database rebuilds its pool.
- **Consoles** — several tabs per connection, each keeping its own SQL, result and
  transaction; closing a console cancels its statement and rolls back its transaction.
- **Objects** — search tables and views by name (`Search Objects`), read a table's
  rebuilt DDL or a view's definition (`Show DDL` on a tree node), copy it or open it
  in an editor tab, and inspect total size, row estimate and index sizes.
- **SQL workbench** — run a statement, see the command tag, row count, duration
  and notices in a dense result grid. Results are capped (default 500 rows) so a
  stray `select *` cannot flood the extension host.
- **Data editor** — open a table from the tree, edit cells, add and mark rows for
  deletion, then commit or roll back the whole batch. Paging and sorting run in
  PostgreSQL; writes are parameterised and sent as one transaction. Filters run
  server-side, multi-column sorting survives paging, and TSV rows can be pasted
  as pending inserts. Generated columns stay read-only, and double-clicking a
  JSON cell opens a formatted preview.
- **Optimistic locking** — every row carries its `xmin`; if another session
  changed it, the commit fails with the conflicting primary keys and writes
  nothing.
- **CSV export** — stream a whole relation to a file you pick; the webview never
  touches the filesystem.
- **CSV/JSON import** — pick a file in the host, map its columns onto the table,
  and stream it in batches of 1000 rows. A failing batch rolls back and the
  first 100 problem rows are reported with line numbers; the run can be
  cancelled from the same dialog.
- **Schema changes** — create a table, add or alter a column (type, default,
  nullability), create an index or drop a table from a **Schema** dialog. The
  host renders quoted SQL, grades each statement (`safe`/`caution`/`dangerous`)
  and asks you to type the table name (drop) or `CONFIRM` (type change, new
  `NOT NULL`) before applying. DDL is refused on read-only connections and
  while a transaction is open; previewed SQL can be copied or opened in an
  editor tab.
- **Safety** — passwords never leave the extension host: they live in
  `SecretStorage`, never in settings, logs or webview messages. Mark a profile
  **read-only** and only `select`/`with`/`show`/`explain` statements are sent,
  and the data editor refuses to commit.
- **Cancellation** — every query runs with a cancel button, a statement timeout
  and a hard row cap. Commits and CSV exports register an abort controller too:
  cancelling rolls the transaction back and deletes the partial file.
- **Completion and formatting** — typing in a `.sql` editor completes keywords,
  schemas, tables and columns from the host's schema cache. `DataForge: Format
  SQL` formats the selection (or the whole document) through a `WorkspaceEdit`,
  so undo keeps working.
- **History and timing** — the last 200 statements live in `globalState`;
  `DataForge: Query History` reloads one into the editor. The status bar shows
  the duration of the last run and slow queries (`dataforge.slowQueryMs`) are
  logged.
- **EXPLAIN** — one read-only statement at a time, rendered as a tree of nodes
  (type, relation, index, cost, rows, actual time) with the raw JSON one click
  away.
- **Sessions and slow queries** — a sessions panel lists every other backend
  with state, duration, query and wait event; long-running ones are flagged and
  you can terminate a session that belongs to your own role after confirming.
  `DataForge: Slow Queries` opens the slowest successful statements from
  history and loads the chosen one into the editor.
- **Session restore** — after a window reload the workbench reopens its console
  tabs, SQL, active connection and the last data view (relation, filters, sort,
  page). Results, pending edits, transactions and credentials are not restored,
  and nothing reconnects automatically.
- **Transactions** — `Begin transaction` opens a dedicated backend; later runs
  go through it until you commit or roll back, and the host rolls the session
  back on panel close, disconnect or deactivate.

## Requirements

- VS Code 1.115 or newer.
- A PostgreSQL server reachable from the machine running VS Code (MySQL and SQL Server connections only need queries and metadata).

## Getting started

Open the **DataForge** activity bar view, press **New**, fill in host, port,
database and user, use **Test** to verify, then **Create**. Expand the saved
connection to browse schemas and tables, or press **Run** (Ctrl/⌘ + Enter) in
the workbench to execute SQL. Select part of the editor before pressing Run to
execute only the selection.

## Settings

| Setting                         | Default | Purpose                                            |
| ------------------------------- | ------- | -------------------------------------------------- |
| `dataforge.connectTimeoutMs`    | 10000   | How long a connection attempt may take.            |
| `dataforge.maxRows`             | 500     | Rows fetched per query; extra rows are truncated.   |
| `dataforge.statementTimeoutMs`  | 30000   | `statement_timeout` applied to each connection.    |
| `dataforge.slowQueryMs`         | 1000    | Queries at/above this are logged and flagged slow.  |

## Development

```bash
npm install
npm run build        # extension bundle + webview assets
npm run type-check   # both workspaces
npm run test:unit    # host and webview unit tests
```

Press <kbd>F5</kbd> ("Run DataForge Extension") to start an Extension
Development Host. The workbench HTML is written by the extension host so the
CSP nonce stays under its control; the webview bundle is built into
`extension/dist/webview/assets/`.

## Architecture

- `shared/protocol.ts` — dependency-free message contract shared by both sides.
- `extension/src/domain` — profiles, errors, driver ports. No `vscode`, no `pg`.
- `extension/src/application` — connection, query, schema, data-editing, export,
  history, format and transaction-session services plus ports.
- `extension/src/infrastructure` — PostgreSQL, MySQL and SQL Server drivers, SSH tunnel, SQL builder, CSV writer,
  SecretStorage, Memento stores.
- `extension/src/presentation` — tree view, webview panel, message router,
  completion provider, diagnostics, logging.
- `webview/src` — Vue 3 + Pinia + Tailwind workbench; it only ever talks to the
  host through `HostBridge`, never to a database.
