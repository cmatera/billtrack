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
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_SOURCE_BYTES = 30 * 1024 * 1024; // 30MB — generous for a scanned bill schedule

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
    `INSERT INTO warrants (id, dateISO, warrantNo, label, total, invoiceCount, categories, vendors, quality, reconciled, source, sourceFile, sourcePdfPath, notes, createdAt, updatedAt)
     VALUES (@id, @dateISO, @warrantNo, @label, @total, @invoiceCount, @categories, @vendors, @quality, @reconciled, @source, @sourceFile, @sourcePdfPath, @notes, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       dateISO=excluded.dateISO, warrantNo=excluded.warrantNo, label=excluded.label, total=excluded.total,
       invoiceCount=excluded.invoiceCount, categories=excluded.categories, vendors=excluded.vendors,
       quality=excluded.quality, reconciled=excluded.reconciled, source=excluded.source,
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
  fs.writeFileSync(path.join(dir, storedName), buf);

  db.prepare("UPDATE warrants SET sourcePdfPath = ?, sourceFile = ?, updatedAt = ? WHERE id = ?").run(
    path.join(id, storedName),
    filename || existing.sourceFile,
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

app.listen(PORT, () => {
  console.log(`Sutton Bill Ledger listening on :${PORT}`);
  if (!ANTHROPIC_API_KEY) console.log("ANTHROPIC_API_KEY not set — uploads are disabled until it is.");
});
