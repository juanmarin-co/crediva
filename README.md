# Lending Interest Rates

This project provides a small Python 3.13+ CLI for replicating Colombian lending-interest-rate data from the government Socrata portal. Dependencies and commands are managed with `uv`.

## Pulling data

```bash
uv run lending-interest-rates pull
```

Use a different destination when needed:

```bash
uv run lending-interest-rates pull --raw-path data/raw
```

Progress is written to stderr as structured `EVENT key=value` lines.

## Sources

The data is published through two Socrata resources:

- Historical: [`w9zh-vetq`](https://www.datos.gov.co/api/views/w9zh-vetq)
- Recent: [`qzsc-9esp`](https://www.datos.gov.co/api/views/qzsc-9esp)

The historical resource behaves as an append-only sequence. The recent resource is replaced as a complete snapshot. `pull` synchronizes recent first, then historical. It treats Socrata intrinsic row IDs as opaque cursors and does not group or reconcile records by reporting date.

## Storage

```text
data/raw/
├── manifest.json
├── historical/
│   └── pages/
│       ├── page-00000001.csv.gz
│       └── page-00000002.csv.gz
└── recent/
    └── current/
        ├── page-00000001.csv.gz
        └── page-00000002.csv.gz
```

Both sources are stored in gzip-compressed CSV pages of at most 50,000 records, ordered by Socrata's intrinsic `:id`. Socrata's gzip response bytes are persisted directly without client decompression or local recompression. Query pages preserve API field names and the `:id`, `:version`, `:created_at`, and `:updated_at` system columns.

The manifest records the path, size, row count, ID boundaries, download time, and exact row counts by `fecha_corte` for every active page. These reporting-date counts form an index for selecting the minimal raw-page set needed to rebuild a monthly projection; synchronization still relies only on intrinsic IDs. Historical also records its append cursor, while recent records the newest ID used for change detection. File and manifest writes use `.partial` files and atomic replacement.

## Synchronization protocol

Historical pages use keyset pagination:

```sql
SELECT *
WHERE `:id` > 'last-id'
ORDER BY `:id`
LIMIT 50000
```

The initial request omits the `WHERE` clause. Every completed page is written durably before its final ID is checkpointed. A response containing fewer than 50,000 records ends the pull; an empty response creates no page.

For the recent source, `pull` first requests its newest intrinsic ID. If that ID differs from the active generation, it downloads a complete set of `query.csv` pages from the beginning into `recent/next`. Pagination state remains in memory. After the final short page, `next` replaces `current` and the manifest records the new active pages and newest ID.

Interrupted historical pulls resume after the last committed page. Interrupted recent downloads retain `current`; the incomplete `next` directory is discarded and downloaded again on the next pull. No retries are performed automatically.

## Development

Tests exercise commands through boundary implementations, Socrata through a local HTTP server, and storage through temporary directories.

Run the project checks with:

```bash
uv format
uv run ruff check .
uv run pytest
find src -name '*.py' -print0 | xargs -0 uv run python -m py_compile
git diff --check
```
