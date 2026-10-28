# Sutton Bill Ledger

A self-hosted tracker for Sutton Public Schools bill schedule ("warrant") PDFs. Upload a bill schedule, it reads every page, categorizes spending into the School Committee's 13-category taxonomy, tracks spending by vendor (Amazon, Whitewater, etc.), flags whether the batch totals reconcile with the stated cover total, and catches duplicate uploads — with a review step before anything is saved. You can select several PDFs at once; they're queued and read one at a time, and each one's review step waits its turn so it never gets clobbered by the next file in the queue.

This is a self-hosted port of a [claude.ai Artifact](https://claude.ai) version of the same tool. The artifact version got two things for free from the claude.ai platform: a shared database and an AI call to read PDF pages. Neither exists outside claude.ai, so this version replaces them with:

- **Storage**: a SQLite database on disk (`data/warrants.db`), mounted as a Docker volume so it survives container rebuilds.
- **PDF reading**: a direct call to the [Anthropic API](https://console.anthropic.com/) from the server, using your own API key. This is billed to your account — a typical warrant (40-90 pages, read in batches of 6) costs on the order of a few cents per upload.

Every warrant you save also keeps the original uploaded PDF on disk (`data/uploads/<warrant-id>/`), so you can reopen the exact source document later from that warrant's detail view — useful when someone asks "where did this number come from?" months later. Click any row in "Spending by category" or "Spending by vendor" to drill into every row saved under it, across every warrant, each with a link straight to its source PDF. The category drill-down also breaks that category's spending out by vendor, and the vendor drill-down shows each line item's category right back — a batch-summary row is itself a total across however many invoices made up that batch, so both directions are a join (via the batch label each line item and summary row both carry) rather than a stored total, and only cover rows saved with that link; click a vendor or category name in either drill-down to jump straight to its own. If a bill schedule flags an invoice as exceeding its purchase order, that's kept too and surfaced as a badge on the warrant and in the vendor drill-down — a badge that looks implausibly large next to the invoice itself (many times the invoice amount) gets a distinct red warning instead, since that's usually a sign the extraction misread the PDF's "PO BALANCE" column rather than a genuine overage; it shows up in "Needs review" too, so you don't have to spot it by eye. Each warrant also has an editable notes field, in the review step or later from its detail view — handy for flagging something to ask about before a meeting.

A "Needs review" tile flags any warrant that doesn't reconcile, isn't full detail, or had its category rows guessed from vendor line items instead of a real batch-summary table — click it to see the whole list and why, instead of noticing by accident. "Spending trends" breaks category totals out by fiscal year (July–June) against the year before, so a spike or drop stands out instead of being buried in the all-time total — set a budget per category there too (an "Edit budgets" button on the same panel) and each category shows what percent of it you've spent. And "Search bill schedules" runs a full-text search over every stored PDF's actual text — a PO number, an exact dollar amount, anything printed on the page — not just what made it into a category or vendor row. A line above the search box always shows how much of the ledger that search can actually reach (how many warrants are indexed, and how many have no stored PDF at all and can never be indexed), so a search that comes back empty tells you whether that's because nothing matched or because that warrant was never searchable in the first place.

The ledger also backs itself up: once a day, and on demand from the "Backups" section at the bottom of the page, it snapshots the database and every stored PDF into one downloadable `.tar.gz`, keeping the last 14. "Export CSV" in the top bar gives you category/vendor totals; "Export line items" gives you every transaction as its own row instead, for a meeting packet or your own pivot tables.

Each line item is also checked against that vendor's own history: if an invoice is unusually large relative to what that vendor normally runs (at least a few prior data points, and at least 3x the vendor's typical amount, with a dollar floor so a vendor that normally spends a few dollars doesn't get flagged for spending a few dollars more) it's flagged — on the "Needs review" tile, on the warrant's own detail view, in that vendor's drill-down, and live in the review step before you even save. "Settings" in the top bar opens an editor for the category taxonomy and vendor alias list themselves, so a shift in Sutton's batch naming or a new recurring vendor is a quick edit there instead of a code change and redeploy.

"Setup" in the top bar opens a separate page for the two backfill scripts below and for backups — run either with a click (dry-run first if you want to preview, then for real) and watch its console output live, instead of needing a shell into the container. Both also run automatically once a day on their own, and skip themselves (no process even spawned) on any day neither has new warrants to process — the Setup page's "Recent runs" list for each one shows whether a given run was manual or automatic and what it actually did, including the days it found nothing pending and did nothing.

Everything else — the category taxonomy, vendor normalization, the review-before-save flow, sortable/resizable columns — is the same frontend code.

## Running it

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)). Leave it blank to run read-only (uploads are disabled until a key is set).
2. `docker compose up -d --build`
3. Open `http://localhost:3000`

A fresh install starts with an empty ledger — nothing is seeded. Upload your first bill schedule through the tool to get started; each one you confirm through the review step adds full category + vendor detail, plus the source PDF for later reference.

## Project layout

```
server.js              Express app: static file server + /api routes
public/index.html      The main ledger page (single file, no build step)
public/setup.html      Backups + one-time backfills, run from the browser (see below)
scripts/               The same one-time maintenance scripts, runnable by hand or from public/setup.html
data/warrants.db       The live SQLite store (gitignored; created at runtime)
data/uploads/<id>/     Original source PDFs, one folder per warrant (gitignored)
data/backups/          Downloadable backup archives, pruned to the last 14 (gitignored)
Dockerfile, docker-compose.yml
```

### Backfilling category drill-down detail for older warrants

Warrants uploaded before the per-row `summaryRows` detail existed only have
the old aggregate category/vendor totals — clicking into a category for one
of them shows "No row-level detail saved." Since the original PDF is still
on disk for any warrant that was uploaded through the browser, you don't
need to re-upload it: `scripts/backfill-summary-rows.js` re-reads the stored
PDF directly and re-runs the same extraction, filling in just the
`summaryRows`/`lineItems` detail (it never touches the totals or categories
you already have).

Easiest way to run it: open **Setup** in the top bar of the ledger page,
check "Dry run" to preview first, then uncheck it and run for real — the
console output streams into the page as it goes. Or run it by hand inside
the container, with the server already up:

```
docker compose exec ledger node scripts/backfill-summary-rows.js --dry-run   # preview first
docker compose exec ledger node scripts/backfill-summary-rows.js            # then for real
```

It only processes warrants that have a stored source PDF and no existing
`summaryRows`, so it's safe to run more than once. Each warrant it touches
costs about the same as a normal upload (a few cents of Anthropic API
usage). Flags: `--id=<warrant-id>` to backfill just one, `--force` to redo
one that already has detail — both are exposed as fields on the Setup page
too.

The same run also fills in the `batch` link each line item needs for the
"Vendors in this category" breakdown in the category drill-down. A warrant
backfilled (or uploaded) before that link was added only shows a note that
vendor detail isn't linked yet for it — rerun this with "Force redo"
checked (`--force`) to add it.

### Backfilling full-text search for older warrants

Full-text search only covers PDFs indexed after upload — a warrant saved
before that existed isn't in the index yet. `scripts/backfill-pdf-text.js`
fixes this with a local `pdftotext` pass over every stored PDF; it's pure
text extraction, no Anthropic API calls, so there's no cost and it doesn't
need the server running (it writes to the database directly). Same as
above, run it from **Setup** in the top bar, or by hand:

```
docker compose exec ledger node scripts/backfill-pdf-text.js --dry-run
docker compose exec ledger node scripts/backfill-pdf-text.js
```

### Automatic daily runs

Both backfills above also run on their own once a day (staggered a few
minutes apart, and after the daily backup, so a restart doesn't fire all
three at once) — you don't need to remember to open Setup after every
upload. Each day's check is a single, cheap count of how many warrants are
actually missing that job's detail; if that count is zero, the script is
never even spawned, so a ledger that isn't getting new uploads costs
nothing beyond that one query, forever. The Setup page's "Recent runs" list
for each job records every check this server process has made — whether it
ran for real, found nothing pending and skipped itself, or failed — along
with whether it was this automatic schedule or someone clicking "Run," so
you can tell at a glance whether the daily run has been doing its job. That
history is in-memory only and resets on a restart, same as the live log
above it; it's a record of recent activity, not something to depend on
long-term (the backfills themselves are still safe to just re-run by hand
any time if you're ever unsure).

## API

- `GET /api/config` — `{ extractionEnabled: boolean }`, whether `ANTHROPIC_API_KEY` is set.
- `GET /api/warrants` — all warrant records.
- `PUT /api/warrants/:id` — replace one warrant record (used by the review modal's "Save to ledger").
- `POST /api/warrants/:id/source` — `{ filename, mediaType, data }` (base64) → stores the original PDF for an already-saved warrant. Internal to the frontend.
- `GET /api/warrants/:id/source` — streams the stored PDF back (opens inline in the browser).
- `DELETE /api/warrants/:id` — remove one warrant record and its stored source PDF.
- `GET /api/export.csv` — category + vendor totals as a CSV download.
- `GET /api/export-line-items.csv` — every included batch-summary row as its own CSV line (date, warrant #, batch, department, category, amount).
- `GET /api/search?q=...` — full-text search over every stored PDF's extracted text (requires at least 3 characters); returns matching warrants with short snippets. The full text itself never leaves the server.
- `GET /api/search-coverage` — `{ totalWarrants, withSourcePdf, indexed }`, so the frontend can show how much of the ledger `/api/search` can actually reach — `withSourcePdf` is warrants with a source PDF on disk at all, `indexed` is how many of those have been through the pdf-text backfill.
- `GET /api/budgets` — every fiscal year's budgeted amount per category, as `{ "2026": { "Technology": 75000, ... }, ... }`.
- `PUT /api/budgets/:fy` — replace one fiscal year's whole budget with the given `{category: amount}` map; a category left out is cleared for that FY.
- `GET /api/backups` — list existing backup archives (name, size, created date).
- `POST /api/backups` — trigger a fresh backup now (same thing the daily schedule does); returns its filename.
- `GET /api/backups/:name` — download one backup archive.
- `DELETE /api/backups/:name` — delete one backup archive.
- `POST /api/backfill/:job/run` — start one of the backfill scripts (`:job` is `summary-rows` or `pdf-text`) as a background process, body `{ dryRun, force, id }` (all optional) mapped straight to that script's own `--dry-run`/`--force`/`--id=` flags. `409` if that job is already running; only one of each runs at a time. The same two jobs also run automatically once a day — see "Automatic daily runs" above.
- `GET /api/backfill/:job/status` — `{ running, log, startedAt, finishedAt, exitCode, pending, history }` for that job. `pending` is a live count of how many warrants that job would currently touch (computed fresh on every call, not cached). `history` is up to the last 20 runs this server process has made — manual or automatic, including ones that skipped themselves because nothing was pending — newest first, each `{ at, trigger: "manual"|"scheduled", outcome: "completed"|"skipped"|"failed", summary }`. All of this is in-memory only and resets on restart. The frontend (`public/setup.html`) polls the live fields while `running` to show the script's console output live, and renders `history` as a static table.
- `GET /api/taxonomy` — the category-matching rules, in order: `{ rules: [{ name, groups, isDefault }, ...] }`. `groups` is disjunctive-normal-form — an array of OR'd groups, each an array of terms that must ALL appear (AND) in a department/batch label for that group to match. The one rule with `isDefault: true` is used when nothing else matches.
- `PUT /api/taxonomy` — replace the whole rule list with `{ rules: [...] }`, same shape as the GET — names must be non-empty and unique, and exactly one rule must be `isDefault: true`.
- `GET /api/vendor-aliases` — the vendor-alias list, in order: `{ aliases: [{ canonical, triggers }, ...] }`. Any invoice vendor name containing one of a row's triggers (case-insensitive substring match) is folded into that canonical name.
- `PUT /api/vendor-aliases` — replace the whole alias list with `{ aliases: [...] }`, same shape as the GET; a row with no canonical name or no triggers is dropped.
- `POST /api/extract` — `{ prompt, images: [{data, mediaType}] }` → calls the Anthropic API with the page images and returns the parsed JSON reply. Internal to the frontend; not meant to be called directly.

## Notes

- This is built for one person's use (a single School Committee member tracking bill schedules), not multi-user access control — there's no login. Don't expose port 3000 to the open internet without putting it behind your own auth (a reverse proxy with basic auth, a VPN, Tailscale, etc.).
- The categorization taxonomy and vendor alias list are stored in the database (`taxonomy_rules` / `vendor_aliases`), seeded once from Sutton's original 13-category taxonomy — edit them from "Settings" in the top bar rather than in code. `scripts/backfill-summary-rows.js` reads the same tables, so a backfill honors whatever rules are currently in effect.
- Per-invoice anomaly flagging (an invoice unusually large for that vendor) is computed entirely in the browser from the line items already loaded — nothing is stored for it, so changing the thresholds (`ANOMALY_MIN_HISTORY`, `ANOMALY_MULTIPLE`, `ANOMALY_MIN_DELTA` near the top of the script in `public/index.html`) takes effect immediately on the next load, no migration needed.
- The source PDFs have two adjacent, easily-confused columns on invoice-detail pages: "EXCEEDS PO BY" and "PO BALANCE". Older extractions could occasionally store the PO balance (a running total, often much larger) in the `exceedsPoBy` field instead of the real, usually blank/zero, overage — the extraction prompt now spells out the difference explicitly, so this shouldn't happen on new uploads or backfills going forward. To help find anything already saved with the mixup, any line item whose `exceedsPoBy` is at least `PO_OVERAGE_IMPLAUSIBLE_MULTIPLE` (3x, in `public/index.html`) times its own invoice amount gets a red "implausible, check the PDF" badge instead of the normal amber "exceeds PO" one — on the warrant detail view, the vendor drill-down, and the pre-save review step — and the warrant shows up in "Needs review" so you can find every affected warrant from one place rather than opening each PDF by hand. Once you've checked the PDF, re-run `scripts/backfill-summary-rows.js --force --id=<warrant-id>` (from the Setup page, with "Force redo" checked and that warrant's id filled in) to re-extract just that warrant with the corrected prompt, rather than re-running the backfill on everything.
- `ANTHROPIC_MODEL` in `.env` lets you pin a specific model; see [Anthropic's model docs](https://docs.claude.com/en/docs/about-claude/models) for current ids.
- Backups and full-text search depend on `poppler-utils` and `tar` being present in the image (both installed in the Dockerfile). A backup or PDF indexing attempt fails gracefully if either is missing — nothing else breaks — but you'll want to rebuild the image (`docker compose up -d --build`) if you're upgrading from a version of this app that predates them.
