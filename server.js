// Sutton Bill Ledger — self-hosted server.
//
// Replaces the two things the claude.ai Artifact version got for free from
// the platform: a shared database (here: a SQLite file on disk) and an AI
// call to read PDF pages (here: a direct call to the Anthropic API using
// your own key). Everything else — the categorization taxonomy, the
// review-before-save flow, the dashboard — is the same frontend logic.
//
// A fresh install starts with an empty ledger — nothing is seeded. Each
// saved warrant keeps the original uploaded PDF on disk (data/uploads/<id>/)
// so you can reopen the source document later from the warrant's detail view.

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_SOURCE_BYTES = 30 * 1024 * 1024; // 30MB — generous for a scanned bill schedule
const BACKUP_KEEP = 14; // rotate: keep the most recent N backups
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // one scheduled backup a day

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS warrants (
    id TEXT PRIMARY KEY,
    dateISO TEXT,
    warrantNo TEXT,
    label TEXT,
    total REAL,
    invoiceCount INTEGER,
    categories TEXT,
    vendors TEXT,
    summaryRows TEXT,
    lineItems TEXT,
    quality TEXT,
    reconciled INTEGER,
    source TEXT,
    sourceFile TEXT,
    sourcePdfPath TEXT,
    notes TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )
`);
// Migrate an existing database (e.g. already deployed and in use) that
// predates the summaryRows column — CREATE TABLE IF NOT EXISTS above is a
// no-op against it, so add the column directly if it's missing.
{
  const cols = db.prepare("PRAGMA table_info(warrants)").all().map((c) => c.name);
  if (!cols.includes("summaryRows")) db.exec("ALTER TABLE warrants ADD COLUMN summaryRows TEXT");
  // lineItems: per-vendor-line detail behind the "Spending by vendor" totals,
  // same idea as summaryRows but for vendors — lets a vendor be clicked into
  // just like a category can. Missing on warrants saved before this existed.
  if (!cols.includes("lineItems")) db.exec("ALTER TABLE warrants ADD COLUMN lineItems TEXT");
  // pdfText: the full plain text of the stored source PDF (via pdftotext),
  // used only server-side by /api/search — never sent in the main warrant
  // list, since it can be large. Missing until a PDF is (re-)uploaded or
  // scripts/backfill-pdf-text.js is run.
  if (!cols.includes("pdfText")) db.exec("ALTER TABLE warrants ADD COLUMN pdfText TEXT");
}

// One row per (fiscal year, category) — a budgeted amount to compare each
// category's actual spend against on the "Spending trends" panel. A brand
// new table, so CREATE TABLE IF NOT EXISTS alone is enough; no migration
// needed on an existing database.
db.exec(`
  CREATE TABLE IF NOT EXISTS budgets (
    fy INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (fy, category)
  )
`);

// Category-matching rules and the vendor-alias list used to auto-categorize
// every uploaded bill schedule — editable from the Settings panel in the UI
// instead of requiring a code change + redeploy. Brand-new tables, so
// CREATE TABLE IF NOT EXISTS alone is enough; no column migration needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS taxonomy_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    groups TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    sortOrder INTEGER NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS vendor_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical TEXT NOT NULL,
    triggers TEXT NOT NULL,
    sortOrder INTEGER NOT NULL
  )
`);

// Seed from the taxonomy/aliases this app shipped with before either table
// existed (the old hardcoded CATEGORIES/categorize()/VENDOR_ALIASES in
// public/index.html) — only when the table is empty, so an upgrade never
// clobbers rules someone has since edited through the Settings panel.
// "groups" is disjunctive-normal-form: an array of OR'd groups, each an
// array of terms that must ALL be present (AND) — e.g. Special Education —
// Transportation needs both "special education" and "transport".
const DEFAULT_TAXONOMY = [
  { name: "Special Education — Transportation", groups: [["special education", "transport"]] },
  { name: "Special Education — Tuition & Services", groups: [["special education"]] },
  { name: "Transportation — General (Contracted)", groups: [["transport"], ["bus fee"]] },
  { name: "Maintenance & Facilities", groups: [["maintenance"], ["facility"], ["facilities"]] },
  { name: "Capital Projects", groups: [["capital"]] },
  { name: "Utilities", groups: [["utilit"]] },
  { name: "Technology", groups: [["technology"], ["software"]] },
  { name: "Athletics", groups: [["athletic"]] },
  { name: "Food Services", groups: [["food service"]] },
  { name: "Administration", groups: [["admin"], ["tuition reimbursement"]] },
  { name: "Curriculum / Instructional", groups: [["early learning"], ["elementary"], ["middle school"], ["high school"], ["library"]] },
  { name: "Health", groups: [["health"]] },
  { name: "Extracurricular & Revolving Funds", groups: [], isDefault: true },
];
const DEFAULT_VENDOR_ALIASES = [
  { canonical: "Amazon Capital Services", triggers: ["amazon", "amzn"] },
  { canonical: "Whitewater, Inc.", triggers: ["whitewater"] },
  { canonical: "Spencer Meadow Solar", triggers: ["spencer meadow"] },
  { canonical: "Evergreen Center", triggers: ["evergreen center"] },
  { canonical: "Great Minds PBC", triggers: ["great minds"] },
  { canonical: "AA Transportation", triggers: ["aa transportation"] },
  { canonical: "National Grid", triggers: ["national grid"] },
  { canonical: "RFK Community Alliance", triggers: ["rfk community"] },
];
if (db.prepare("SELECT COUNT(*) AS n FROM taxonomy_rules").get().n === 0) {
  const insert = db.prepare("INSERT INTO taxonomy_rules (name, groups, isDefault, sortOrder) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    DEFAULT_TAXONOMY.forEach((r, i) => insert.run(r.name, JSON.stringify(r.groups), r.isDefault ? 1 : 0, i));
  })();
}
if (db.prepare("SELECT COUNT(*) AS n FROM vendor_aliases").get().n === 0) {
  const insert = db.prepare("INSERT INTO vendor_aliases (canonical, triggers, sortOrder) VALUES (?, ?, ?)");
  db.transaction(() => {
    DEFAULT_VENDOR_ALIASES.forEach((a, i) => insert.run(a.canonical, JSON.stringify(a.triggers), i));
  })();
}

// Escapes % _ and \ for a LIKE pattern using \ as the escape character.
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

function rowToWarrant(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    dateISO: row.dateISO,
    warrantNo: row.warrantNo,
    label: row.label,
    total: row.total,
    invoiceCount: row.invoiceCount,
    categories: row.categories ? JSON.parse(row.categories) : {},
    vendors: row.vendors ? JSON.parse(row.vendors) : {},
    // Per-row detail behind the category totals (one row per included
    // batch-summary row) — lets the UI drill from a category into the
    // individual rows that made it up, each traceable to its warrant's
    // source PDF. Absent on warrants saved before this was added.
    summaryRows: row.summaryRows ? JSON.parse(row.summaryRows) : [],
    // Per-row detail behind the vendor totals — one row per included vendor
    // line item, each carrying its normalized vendor name (so it matches
    // "Spending by vendor" exactly) and any purchase-order overage flagged
    // on the bill schedule. Absent on warrants saved before this was added.
    lineItems: row.lineItems ? JSON.parse(row.lineItems) : [],
    quality: row.quality,
    reconciled: row.reconciled === null ? null : Boolean(row.reconciled),
    source: row.source,
    sourceFile: row.sourceFile || null,
    hasSourcePdf: Boolean(row.sourcePdfPath),
    notes: row.notes || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function getWarrantRow(id) {
  return db.prepare("SELECT * FROM warrants WHERE id = ?").get(id);
}

// Tolerant JSON extraction from a Claude reply: the whole reply, or a
// fenced code block, or the first {/[ to the last }/] in the text.
function tolerantJsonParse(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch (_) {}
  }
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {}
  }
  return undefined;
}

const app = express();
app.use(express.json({ limit: "45mb" })); // batches of page images / a source PDF as base64 add up
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ extractionEnabled: Boolean(ANTHROPIC_API_KEY) });
});

app.get("/api/warrants", (req, res) => {
  const rows = db.prepare("SELECT * FROM warrants ORDER BY dateISO").all();
  res.json(rows.map(rowToWarrant));
});

app.put("/api/warrants/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return res.status(400).json({ error: "bad id" });
  const existing = getWarrantRow(id);
  const body = req.body || {};
  const now = new Date().toISOString();
  const row = {
    id,
    dateISO: body.dateISO ?? null,
    warrantNo: body.warrantNo ?? null,
    label: body.label ?? null,
    total: body.total ?? null,
    invoiceCount: body.invoiceCount ?? null,
    categories: JSON.stringify(body.categories || {}),
    vendors: JSON.stringify(body.vendors || {}),
    summaryRows: JSON.stringify(Array.isArray(body.summaryRows) ? body.summaryRows : []),
    lineItems: JSON.stringify(Array.isArray(body.lineItems) ? body.lineItems : []),
    quality: body.quality ?? null,
    reconciled: body.reconciled === null || body.reconciled === undefined ? null : body.reconciled ? 1 : 0,
    source: body.source ?? null,
    sourceFile: body.sourceFile ?? (existing ? existing.sourceFile : null),
    sourcePdfPath: existing ? existing.sourcePdfPath : null, // set only via /source upload
    notes: body.notes ?? null,
    createdAt: body.createdAt || (existing ? existing.createdAt : now),
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO warrants (id, dateISO, warrantNo, label, total, invoiceCount, categories, vendors, summaryRows, lineItems, quality, reconciled, source, sourceFile, sourcePdfPath, notes, createdAt, updatedAt)
     VALUES (@id, @dateISO, @warrantNo, @label, @total, @invoiceCount, @categories, @vendors, @summaryRows, @lineItems, @quality, @reconciled, @source, @sourceFile, @sourcePdfPath, @notes, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       dateISO=excluded.dateISO, warrantNo=excluded.warrantNo, label=excluded.label, total=excluded.total,
       invoiceCount=excluded.invoiceCount, categories=excluded.categories, vendors=excluded.vendors,
       summaryRows=excluded.summaryRows, lineItems=excluded.lineItems, quality=excluded.quality, reconciled=excluded.reconciled, source=excluded.source,
       sourceFile=excluded.sourceFile, notes=excluded.notes, updatedAt=excluded.updatedAt`
  ).run(row);
  res.json({ ok: true, id });
});

// Stores the original uploaded PDF for a warrant that's already been saved,
// so it can be reopened later for reference. Separate from the PUT above so
// a slow/large upload never blocks saving the ledger record itself.
app.post("/api/warrants/:id/source", (req, res) => {
  const id = req.params.id;
  const existing = getWarrantRow(id);
  if (!existing) return res.status(404).json({ error: "No warrant on file with that id — save it first." });
  const { filename, data, mediaType } = req.body || {};
  if (!data || typeof data !== "string") return res.status(400).json({ error: "Expected { filename, data, mediaType }" });
  if (mediaType && mediaType !== "application/pdf") return res.status(400).json({ error: "Only application/pdf is accepted." });
  let buf;
  try {
    buf = Buffer.from(data, "base64");
  } catch (e) {
    return res.status(400).json({ error: "data must be base64." });
  }
  if (buf.length > MAX_SOURCE_BYTES) return res.status(413).json({ error: "PDF is too large to store (30MB limit)." });

  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  // Wipe any previous source PDF for this warrant before writing the new one.
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const safeName = (filename || "warrant.pdf").replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 150) || "warrant.pdf";
  const storedName = crypto.randomBytes(4).toString("hex") + "-" + safeName;
  const storedPath = path.join(dir, storedName);
  fs.writeFileSync(storedPath, buf);

  // Index the PDF's text for /api/search. Best-effort: if poppler-utils
  // isn't in this image yet (pre-dates its addition to the Dockerfile), the
  // upload still succeeds — the warrant just won't be searchable until the
  // image is rebuilt and scripts/backfill-pdf-text.js is run once.
  let pdfText = null;
  try {
    pdfText = execFileSync("pdftotext", [storedPath, "-"], { maxBuffer: 20 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    console.error(`pdftotext failed for warrant ${id} — it won't be full-text searchable: ${(e && e.message) || e}`);
  }

  db.prepare("UPDATE warrants SET sourcePdfPath = ?, sourceFile = ?, pdfText = ?, updatedAt = ? WHERE id = ?").run(
    path.join(id, storedName),
    filename || existing.sourceFile,
    pdfText,
    new Date().toISOString(),
    id
  );
  res.json({ ok: true });
});

app.get("/api/warrants/:id/source", (req, res) => {
  const row = getWarrantRow(req.params.id);
  if (!row || !row.sourcePdfPath) return res.status(404).json({ error: "No source PDF on file for this warrant." });
  const filePath = path.join(UPLOADS_DIR, row.sourcePdfPath);
  if (!filePath.startsWith(UPLOADS_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: "Source PDF is missing on disk." });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${(row.sourceFile || "warrant.pdf").replace(/"/g, "")}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Full-text search across every stored PDF's extracted text (see pdfText
// above). pdfText itself never leaves the server — only short snippets
// around each match do, since a warrant's PDF text can be large and this
// isn't meant to be a bulk export.
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.json({ results: [] });
  const pattern = "%" + likeEscape(q) + "%";
  const rows = db.prepare("SELECT id, dateISO, warrantNo, label, pdfText, sourcePdfPath FROM warrants WHERE pdfText LIKE ? ESCAPE '\\'").all(pattern);
  const needle = q.toLowerCase();
  const results = rows.slice(0, 30).map((row) => {
    const text = row.pdfText || "";
    const lower = text.toLowerCase();
    const snippets = [];
    let idx = lower.indexOf(needle);
    while (idx !== -1 && snippets.length < 3) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(text.length, idx + needle.length + 50);
      snippets.push((start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : ""));
      idx = lower.indexOf(needle, idx + needle.length);
    }
    return {
      id: row.id,
      dateISO: row.dateISO,
      warrantNo: row.warrantNo,
      label: row.label,
      hasSourcePdf: Boolean(row.sourcePdfPath),
      matchCount: (lower.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length,
      snippets,
    };
  });
  res.json({ results });
});

app.delete("/api/warrants/:id", (req, res) => {
  const row = getWarrantRow(req.params.id);
  if (row && row.sourcePdfPath) {
    const dir = path.join(UPLOADS_DIR, req.params.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.prepare("DELETE FROM warrants WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/export.csv", (req, res) => {
  const warrants = db.prepare("SELECT * FROM warrants").all().map(rowToWarrant);
  const categories = {};
  const vendors = {};
  warrants.forEach((w) => {
    Object.entries(w.categories || {}).forEach(([k, v]) => (categories[k] = (categories[k] || 0) + Number(v || 0)));
    Object.entries(w.vendors || {}).forEach(([k, v]) => (vendors[k] = (vendors[k] || 0) + Number(v || 0)));
  });
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const lines = ["Sutton Bill Ledger export", ""];
  lines.push("Category,Amount");
  Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => lines.push(esc(k) + "," + v.toFixed(2)));
  lines.push("");
  lines.push("Vendor,Amount");
  Object.entries(vendors)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => lines.push(esc(k) + "," + v.toFixed(2)));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="sutton-bill-ledger.csv"');
  res.send(lines.join("\n"));
});

// One row per transaction (every included batch-summary row, across every
// warrant) — for building a meeting packet or your own pivot tables, where
// the totals-only export above isn't enough detail.
app.get("/api/export-line-items.csv", (req, res) => {
  const warrants = db.prepare("SELECT * FROM warrants ORDER BY dateISO").all().map(rowToWarrant);
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const lines = ["Date,Warrant #,Batch,Department,Category,Amount"];
  warrants.forEach((w) => {
    (w.summaryRows || []).forEach((r) => {
      lines.push([esc(w.label || w.dateISO), esc(w.warrantNo), esc(r.batch), esc(r.department), esc(r.category), Number(r.amount || 0).toFixed(2)].join(","));
    });
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="sutton-bill-ledger-line-items.csv"');
  res.send(lines.join("\n"));
});

// Budgeted amount per (fiscal year, category), compared against actual
// spend on the "Spending trends" panel. All FYs come back in one shot
// since the client caches budgets alongside the warrant list.
app.get("/api/budgets", (req, res) => {
  const rows = db.prepare("SELECT fy, category, amount FROM budgets").all();
  const out = {};
  rows.forEach((r) => {
    (out[r.fy] = out[r.fy] || {})[r.category] = r.amount;
  });
  res.json(out);
});

// Replaces the full budget for one fiscal year with the given
// {category: amount} map — whichever categories aren't in the body are
// cleared for that FY, same "whole-object replace" shape as PUT /warrants.
app.put("/api/budgets/:fy", (req, res) => {
  const fy = Number(req.params.fy);
  if (!Number.isInteger(fy)) return res.status(400).json({ error: "fy must be an integer" });
  const body = req.body || {};
  const entries = Object.entries(body)
    .map(([cat, amt]) => [cat, Number(amt)])
    .filter(([, amt]) => Number.isFinite(amt) && amt > 0);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM budgets WHERE fy = ?").run(fy);
    const insert = db.prepare("INSERT INTO budgets (fy, category, amount) VALUES (?, ?, ?)");
    entries.forEach(([cat, amt]) => insert.run(fy, cat, amt));
  });
  tx();
  res.json({ ok: true, fy, count: entries.length });
});

// The category-matching rules and vendor-alias list, editable from the
// Settings panel in the UI — same "whole-object replace" shape as budgets
// above: the client sends the complete desired list and the server replaces
// it wholesale rather than merging.
app.get("/api/taxonomy", (req, res) => {
  const rows = db.prepare("SELECT name, groups, isDefault FROM taxonomy_rules ORDER BY sortOrder").all();
  res.json({ rules: rows.map((r) => ({ name: r.name, groups: JSON.parse(r.groups), isDefault: Boolean(r.isDefault) })) });
});

app.put("/api/taxonomy", (req, res) => {
  const body = req.body || {};
  const rules = Array.isArray(body.rules) ? body.rules : [];
  if (!rules.length) return res.status(400).json({ error: "At least one category is required." });
  const cleaned = [];
  const seen = new Set();
  for (const r of rules) {
    const name = String((r && r.name) || "").trim();
    if (!name) return res.status(400).json({ error: "Every category needs a name." });
    const key = name.toLowerCase();
    if (seen.has(key)) return res.status(400).json({ error: `Category name "${name}" is used more than once.` });
    seen.add(key);
    const groups = Array.isArray(r.groups)
      ? r.groups
          .map((g) => (Array.isArray(g) ? g.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean) : []))
          .filter((g) => g.length)
      : [];
    cleaned.push({ name, groups, isDefault: Boolean(r.isDefault) });
  }
  const defaults = cleaned.filter((r) => r.isDefault);
  if (defaults.length !== 1) return res.status(400).json({ error: "Pick exactly one default category (used when nothing else matches)." });
  db.transaction(() => {
    db.prepare("DELETE FROM taxonomy_rules").run();
    const insert = db.prepare("INSERT INTO taxonomy_rules (name, groups, isDefault, sortOrder) VALUES (?, ?, ?, ?)");
    cleaned.forEach((r, i) => insert.run(r.name, JSON.stringify(r.groups), r.isDefault ? 1 : 0, i));
  })();
  res.json({ ok: true, count: cleaned.length });
});

app.get("/api/vendor-aliases", (req, res) => {
  const rows = db.prepare("SELECT canonical, triggers FROM vendor_aliases ORDER BY sortOrder").all();
  res.json({ aliases: rows.map((r) => ({ canonical: r.canonical, triggers: JSON.parse(r.triggers) })) });
});

app.put("/api/vendor-aliases", (req, res) => {
  const body = req.body || {};
  const aliases = Array.isArray(body.aliases) ? body.aliases : [];
  const cleaned = [];
  for (const a of aliases) {
    const canonical = String((a && a.canonical) || "").trim();
    const triggers = Array.isArray(a && a.triggers) ? a.triggers.map((t) => String(t || "").trim()).filter(Boolean) : [];
    if (!canonical || !triggers.length) continue; // silently drop incomplete rows rather than erroring
    cleaned.push({ canonical, triggers });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM vendor_aliases").run();
    const insert = db.prepare("INSERT INTO vendor_aliases (canonical, triggers, sortOrder) VALUES (?, ?, ?)");
    cleaned.forEach((a, i) => insert.run(a.canonical, JSON.stringify(a.triggers), i));
  })();
  res.json({ ok: true, count: cleaned.length });
});

app.post("/api/extract", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  const { prompt, images } = req.body || {};
  if (!prompt || !Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: "Expected { prompt: string, images: [{data, mediaType}] }" });
  }
  try {
    const content = [
      { type: "text", text: prompt },
      ...images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data },
      })),
    ];
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({ error: (data && data.error && data.error.message) || "Anthropic API error" });
    }
    const text = (data.content || []).map((b) => b.text || "").join("");
    const parsed = tolerantJsonParse(text);
    if (parsed === undefined) return res.status(422).json({ error: "Claude's reply had no parseable JSON.", raw: text });
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// --- Backups -----------------------------------------------------------
// A single downloadable .tar.gz per backup: a consistent SQLite snapshot
// (via better-sqlite3's online backup API, so it's safe to take even while
// the server is handling requests under WAL) plus a copy of every stored
// source PDF. Runs automatically on a schedule and on demand via the API.
const BACKUP_NAME_RE = /^sutton-bill-ledger-backup-[0-9TZ-]+\.tar\.gz$/;

async function createBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-backup-"));
  try {
    await db.backup(path.join(workDir, "warrants.db"));
    const tarArgs = ["-czf"];
    const archiveName = `sutton-bill-ledger-backup-${stamp}.tar.gz`;
    const archivePath = path.join(BACKUPS_DIR, archiveName);
    tarArgs.push(archivePath, "-C", workDir, "warrants.db");
    if (fs.existsSync(UPLOADS_DIR) && fs.readdirSync(UPLOADS_DIR).length) {
      fs.cpSync(UPLOADS_DIR, path.join(workDir, "uploads"), { recursive: true });
      tarArgs.push("-C", workDir, "uploads");
    }
    execFileSync("tar", tarArgs);
    return { archiveName, archivePath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function listBackups() {
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, name));
      return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneOldBackups(keep) {
  const backups = listBackups();
  backups.slice(keep).forEach((b) => fs.unlinkSync(path.join(BACKUPS_DIR, b.name)));
}

app.get("/api/backups", (req, res) => {
  res.json({ backups: listBackups() });
});

// Triggers a fresh backup right now (same thing the daily schedule does)
// and returns its filename — the frontend then GETs the download route
// below rather than this streaming the file inline.
app.post("/api/backups", async (req, res) => {
  try {
    const { archiveName } = await createBackup();
    pruneOldBackups(BACKUP_KEEP);
    res.json({ ok: true, name: archiveName });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get("/api/backups/:name", (req, res) => {
  const name = req.params.name;
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: "bad filename" });
  const filePath = path.join(BACKUPS_DIR, name);
  if (!filePath.startsWith(BACKUPS_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: "Backup not found." });
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.delete("/api/backups/:name", (req, res) => {
  const name = req.params.name;
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: "bad filename" });
  const filePath = path.join(BACKUPS_DIR, name);
  if (filePath.startsWith(BACKUPS_DIR) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

async function runScheduledBackup() {
  try {
    const { archiveName } = await createBackup();
    pruneOldBackups(BACKUP_KEEP);
    console.log(`Scheduled backup created: ${archiveName}`);
  } catch (e) {
    console.error("Scheduled backup failed:", (e && e.message) || e);
  }
}

app.listen(PORT, () => {
  console.log(`Sutton Bill Ledger listening on :${PORT}`);
  if (!ANTHROPIC_API_KEY) console.log("ANTHROPIC_API_KEY not set — uploads are disabled until it is.");
  // First backup shortly after startup (not instantly, so a crash-restart
  // loop can't spin backups), then every BACKUP_INTERVAL_MS after that.
  // restart: unless-stopped means this effectively runs daily in practice.
  setTimeout(runScheduledBackup, 60 * 1000);
  setInterval(runScheduledBackup, BACKUP_INTERVAL_MS);
});
