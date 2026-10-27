# Sutton Bill Ledger

A self-hosted tracker for Sutton Public Schools bill schedule ("warrant") PDFs. Upload a bill schedule, it reads every page, categorizes spending into the School Committee's 13-category taxonomy, tracks spending by vendor (Amazon, Whitewater, etc.), flags whether the batch totals reconcile with the stated cover total, and catches duplicate uploads — with a review step before anything is saved.

This is a self-hosted port of a [claude.ai Artifact](https://claude.ai) version of the same tool. The artifact version got two things for free from the claude.ai platform: a shared database and an AI call to read PDF pages. Neither exists outside claude.ai, so this version replaces them with:

- **Storage**: a JSON file on disk (`data/warrants.json`), mounted as a Docker volume so it survives container rebuilds.
- **PDF reading**: a direct call to the [Anthropic API](https://console.anthropic.com/) from the server, using your own API key. This is billed to your account — a typical warrant (40-90 pages, read in batches of 6) costs on the order of a few cents per upload.

Everything else — the category taxonomy, vendor normalization, the review-before-save flow, sortable/resizable columns — is the same frontend code.

## Running it

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (get one at [console.anthropic.com](https://console.anthropic.com/)). Leave it blank to run read-only (the seeded ledger below still works; uploads are disabled until a key is set).
2. `docker compose up -d --build`
3. Open `http://localhost:3000`

The container seeds `data/warrants.json` from `seed/warrants.seed.json` on first run only — the 20 historical warrants the committee had already reviewed by hand (confirmed totals and known vendors; no per-warrant category split, since that was never verified at that granularity for the older warrants). Uploading a bill schedule through the tool adds full category + vendor detail for that warrant going forward.

## Project layout

```
server.js              Express app: static file server + /api routes
public/index.html      The whole frontend (single file, no build step)
seed/warrants.seed.json  Initial data, copied into data/ on first run
data/warrants.json     The live store (gitignored; created at runtime)
Dockerfile, docker-compose.yml
```

## API

- `GET /api/config` — `{ extractionEnabled: boolean }`, whether `ANTHROPIC_API_KEY` is set.
- `GET /api/warrants` — all warrant records.
- `PUT /api/warrants/:id` — replace one warrant record (used by the review modal's "Save to ledger").
- `DELETE /api/warrants/:id` — remove one.
- `GET /api/export.csv` — category + vendor totals as a CSV download.
- `POST /api/extract` — `{ prompt, images: [{data, mediaType}] }` → calls the Anthropic API with the page images and returns the parsed JSON reply. Internal to the frontend; not meant to be called directly.

## Notes

- This is built for one person's use (a single School Committee member tracking bill schedules), not multi-user access control — there's no login. Don't expose port 3000 to the open internet without putting it behind your own auth (a reverse proxy with basic auth, a VPN, Tailscale, etc.).
- The categorization taxonomy and vendor alias list live in `public/index.html` (`categorize()` and `VENDOR_ALIASES`) — edit them directly if Sutton's batch naming changes.
- `ANTHROPIC_MODEL` in `.env` lets you pin a specific model; see [Anthropic's model docs](https://docs.claude.com/en/docs/about-claude/models) for current ids.
