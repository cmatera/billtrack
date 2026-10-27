# Sutton Bill Ledger

A self-hosted tracker for Sutton Public Schools bill schedule ("warrant") PDFs. Upload a bill schedule, it reads every page, categorizes spending into the School Committee's 13-category taxonomy, tracks spending by vendor (Amazon, Whitewater, etc.), flags whether the batch totals reconcile with the stated cover total, and catches duplicate uploads — with a review step before anything is saved. You can select several PDFs at once; they're queued and read one at a time, and each one's review step waits its turn so it never gets clobbered by the next file in the queue.

This is a self-hosted port of a [claude.ai Artifact](https://claude.ai) version of the same tool. The artifact version got two things for free from the claude.ai platform: a shared database and an AI call to read PDF pages. Neither exists outside claude.ai, so this version replaces them with:

- **Storage**: a SQLite database on disk (`data/warrants.db`), mounted as a Docker volume so it survives container rebuilds.
- **PDF reading**: a direct call to the [Anthropic API](https://console.anthropic.com/) from the server, using your own API key. This is billed to your account — a typical warrant (40-90 pages, read in batches of 6) costs on the order of a few cents per upload.

Every warrant you save also keeps the original uploaded PDF on disk (`data/uploads/<warrant-id>/`), so you can reopen the exact source document later from that warrant's detail view — useful when someone asks "where did this number come from?" months later. Click any row in "Spending by category" or "Spending by vendor" to drill into every row saved under it, across every warrant, each with a link straight to its source PDF. If a bill schedule flags an invoice as exceeding its purchase order, that's kept too and surfaced as a badge on the warrant and in the vendor drill-down. Each warrant also has an editable notes field, in the review step or later from its detail view — handy for flagging something to ask about before a meeting.

Everything else — the category taxonomy, vendor normalization, the review-before-save flow, sortable/resizable columns — is the same frontend code.

## Running it

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)). Leave it blank to run read-only (uploads are disabled until a key is set).
2. `docker compose up -d --build`
3. Open `http://localhost:3000`

A fresh install starts with an empty ledger — nothing is seeded. Upload your first bill schedule through the tool to get started; each one you confirm through the review step adds full category + vendor detail, plus the source PDF for later reference.

## Project layout

```
server.js              Express app: static file server + /api routes
public/index.html      The whole frontend (single file, no build step)
scripts/               One-time maintenance scripts (see below)
data/warrants.db       The live SQLite store (gitignored; created at runtime)
data/uploads/<id>/     Original source PDFs, one folder per warrant (gitignored)
Dockerfile, docker-compose.yml
```

### Backfilling category drill-down detail for older warrants

Warrants uploaded before the per-row `summaryRows` detail existed only have
the old aggregate category/vendor totals — clicking into a category for one
of them shows "No row-level detail saved." Since the original PDF is still
on disk for any warrant that was uploaded through the browser, you don't
need to re-upload it: `scripts/backfill-summary-rows.js` re-reads the stored
PDF directly and re-runs the same extraction, filling in just the
`summaryRows` detail (it never touches the totals or categories you already
have). Run it inside the container, with the server already up:

```
docker compose exec ledger node scripts/backfill-summary-rows.js --dry-run   # preview first
docker compose exec ledger node scripts/backfill-summary-rows.js            # then for real
```

It only processes warrants that have a stored source PDF and no existing
`summaryRows`, so it's safe to run more than once. Each warrant it touches
costs about the same as a normal upload (a few cents of Anthropic API
usage). Flags: `--id=<warrant-id>` to backfill just one, `--force` to redo
one that already has detail.

## API

- `GET /api/config` — `{ extractionEnabled: boolean }`, whether `ANTHROPIC_API_KEY` is set.
- `GET /api/warrants` — all warrant records.
- `PUT /api/warrants/:id` — replace one warrant record (used by the review modal's "Save to ledger").
- `POST /api/warrants/:id/source` — `{ filename, mediaType, data }` (base64) → stores the original PDF for an already-saved warrant. Internal to the frontend.
- `GET /api/warrants/:id/source` — streams the stored PDF back (opens inline in the browser).
- `DELETE /api/warrants/:id` — remove one warrant record and its stored source PDF.
- `GET /api/export.csv` — category + vendor totals as a CSV download.
- `POST /api/extract` — `{ prompt, images: [{data, mediaType}] }` → calls the Anthropic API with the page images and returns the parsed JSON reply. Internal to the frontend; not meant to be called directly.

## Notes

- This is built for one person's use (a single School Committee member tracking bill schedules), not multi-user access control — there's no login. Don't expose port 3000 to the open internet without putting it behind your own auth (a reverse proxy with basic auth, a VPN, Tailscale, etc.).
- The categorization taxonomy and vendor alias list live in `public/index.html` (`categorize()` and `VENDOR_ALIASES`) — edit them directly if Sutton's batch naming changes.
- `ANTHROPIC_MODEL` in `.env` lets you pin a specific model; see [Anthropic's model docs](https://docs.claude.com/en/docs/about-claude/models) for current ids.
