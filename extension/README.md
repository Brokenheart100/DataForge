# DataForge

A neo-brutalist PostgreSQL IDE inside VS Code. Phase 1 covers the full
connection-to-results loop; Phase 2 adds a data editor and CSV export; Phase 3
adds completion, formatting, history, EXPLAIN and explicit transactions:

- **Connections** — store PostgreSQL connection profiles, test them, connect and
  disconnect from the DataForge sidebar or the workbench.
- **Schema browser** — lazily expand a connection into schemas, then tables and
  views, then columns with types, primary keys, nullability and defaults.
- **SQL workbench** — run a statement, see the command tag, row count, duration
  and notices in a dense result grid. Results are capped (default 500 rows) so a
  stray `select *` cannot flood the extension host.
- **Data editor** — open a table from the tree, edit cells, add and mark rows for
  deletion, then commit or roll back the whole batch. Paging and sorting run in
  PostgreSQL; writes are parameterised and sent as one transaction.
- **Optimistic locking** — every row carries its `xmin`; if another session
  changed it, the commit fails with the conflicting primary keys and writes
  nothing.
- **CSV export** — stream a whole relation to a file you pick; the webview never
  touches the filesystem.
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
- **EXPLAIN** — one read-only statement at a time, rendered as the JSON plan
  PostgreSQL returns.
- **Transactions** — `Begin transaction` opens a dedicated backend; later runs
  go through it until you commit or roll back, and the host rolls the session
  back on panel close, disconnect or deactivate.

## Requirements

- VS Code 1.115 or newer.
- A PostgreSQL server reachable from the machine running VS Code.

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
- `extension/src/infrastructure` — PostgreSQL driver, SQL builder, CSV writer,
  SecretStorage, Memento stores.
- `extension/src/presentation` — tree view, webview panel, message router,
  completion provider, diagnostics, logging.
- `webview/src` — Vue 3 + Pinia + Tailwind workbench; it only ever talks to the
  host through `HostBridge`, never to a database.
