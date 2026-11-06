# DataForge

A neo-brutalist PostgreSQL IDE inside VS Code. Phase 1 covers the full
connection-to-results loop:

- **Connections** — store PostgreSQL connection profiles, test them, connect and
  disconnect from the DataForge sidebar or the workbench.
- **Schema browser** — lazily expand a connection into schemas, then tables and
  views, then columns with types, primary keys, nullability and defaults.
- **SQL workbench** — run a statement, see the command tag, row count, duration
  and notices in a dense result grid. Results are capped (default 500 rows) so a
  stray `select *` cannot flood the extension host.
- **Safety** — passwords never leave the extension host: they live in
  `SecretStorage`, never in settings, logs or webview messages. Mark a profile
  **read-only** and only `select`/`with`/`show`/`explain` statements are sent.
- **Cancellation** — every query runs with a cancel button, a statement timeout
  and a hard row cap.

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
- `extension/src/application` — connection, query and schema services plus ports.
- `extension/src/infrastructure` — PostgreSQL driver, SecretStorage, Memento store.
- `extension/src/presentation` — tree view, webview panel, message router, logging.
- `webview/src` — Vue 3 + Pinia + Tailwind workbench; it only ever talks to the
  host through `HostBridge`, never to a database.
