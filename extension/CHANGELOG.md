# Changelog

## 0.1.4 — 2026-11-07

### Added

- **Light, dark and auto themes** — a header toggle switches the workbench
  between following VS Code, a light reading surface and a dark one. An explicit
  choice is stored in the webview and wins over the editor theme.
- **Session restore** — after a window reload the workbench restores console
  tabs, SQL, the active connection and the last data view (relation, filters,
  sort, page). Results, pending edits, transactions and credentials are not
  restored.
- **SSH tunnels** — optional local port forwarding with password or private-key
  authentication; secrets live in VS Code SecretStorage and the tunnel closes
  with the connection.
- **Read-only SQL Server driver** — `tedious`-based queries, cancellation,
  database/schema/table/column metadata and a capability matrix that hides
  unsupported actions in the webview.
- **CSV/JSON import wizard** — streamed parsing, column mapping preview,
  batch commits (default 1,000 rows), cancelled runs and the first 100 row
  errors.
- **Schema changes** — create table, add/alter column, create index and drop
  table from a structured plan; SQL preview, risk grading, typed confirmation,
  read-only/open-transaction guards and `schema.diff`.
- **Data editor additions** — server-side filters, multi-column sorting,
  paste-as-rows, generated-column read-only cells, JSON preview and page jump.
- **Operations view** — session list/terminate (own role only), an `EXPLAIN`
  plan tree and `DataForge: Slow Queries`.

### Fixed

- Webview requests no longer fail with `DataCloneError` when they contain Vue
  reactive arrays (filters, sorting, pending changes, import mappings).
- MySQL column metadata reports primary-key and generated flags in the right
  order, so editable tables are identified correctly.
- Read-only data pages now explain why they cannot be edited.
- PostgreSQL, MySQL and SQL Server grouping, database switching and secondary
  database browsing are available from the nested explorer.

## 0.1.3 — 2026-11-06

- Nested `Databases` node with one-click database switching.
- Read-only browsing of secondary databases; MySQL driver and connection
  presets.

## 0.1.2 — 2026-11-06

- First Marketplace release: connections, explorer, SQL execution, result grid,
  data editing, CSV export, history, formatting, completion and transactions.
