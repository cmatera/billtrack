// Sutton Bill Ledger — self-hosted server.
//
// Replaces the two things the claude.ai Artifact version got for free from
// the platform: a shared database (here: a JSON file on disk) and an AI
// call to read PDF pages (here: a direct call to the Anthropic API using
// your own key). Everything else — the categorization taxonomy, the
// review-before-save flow, the dashboard — is the same frontend logic.

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "warrants.json");
const SEED_FILE = path.join(__dirname, "seed", "warrants.seed.json");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  const seed = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, "utf8") : "{}";
  fs.writeFileSync(DB_FILE, seed);
  console.log("Seeded", DB_FILE, "from", SEED_FILE);
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to read db file, starting empty:", e.message);
    return {};
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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
app.use(express.json({ limit: "45mb" })); // batches of page images as base64 add up
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ extractionEnabled: Boolean(ANTHROPIC_API_KEY) });
});

app.get("/api/warrants", (req, res) => {
  const db = readDb();
  res.json(Object.entries(db).map(([id, data]) => ({ id, ...data })));
});

app.put("/api/warrants/:id", (req, res) => {
  const db = readDb();
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return res.status(400).json({ error: "bad id" });
  db[id] = { ...req.body, updatedAt: new Date().toISOString() };
  writeDb(db);
  res.json({ ok: true, id });
});

app.delete("/api/warrants/:id", (req, res) => {
  const db = readDb();
  delete db[req.params.id];
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/export.csv", (req, res) => {
  const db = readDb();
  const warrants = Object.values(db);
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
