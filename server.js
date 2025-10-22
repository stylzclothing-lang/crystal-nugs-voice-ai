// server.js — Crystal Nugs Voice AI (Conversation Relay + local ZIP intents)
// Keeps your TwiML with <ConversationRelay ... welcomeGreeting="...">
// Answers ZIP questions with JSON array: [{ zip, fee, minimum, deliveryTime }]
// Loads ZIP rules from file (CN_ZIP_DATA_PATH) or URL (CN_ZIP_DATA_URL)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import { config } from "dotenv";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* -------------------------
   ENV / CONFIG
-------------------------- */
const PORT = process.env.PORT || 8080;

// TwiML (kept minimal: your welcomeGreeting lives in TwiML attributes)
const TTS_PROVIDER = process.env.TWILIO_TTS_PROVIDER || "Google";
const TTS_VOICE = process.env.TWILIO_TTS_VOICE || "en-US-Wavenet-F";
const WELCOME_GREETING =
  process.env.CN_WELCOME ||
  'Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?';

// Conversation Relay needs a publicly reachable WSS URL
// If not provided, we try to guess from APP_BASE_URL
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const WS_RELAY_PUBLIC_URL =
  process.env.WS_RELAY_PUBLIC_URL ||
  (APP_BASE_URL ? APP_BASE_URL.replace(/^http/, "wss") + "/relay" : "");

// Admin & data
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // for /admin/reload-zips
const CN_ZIP_DATA_PATH = process.env.CN_ZIP_DATA_PATH || "./data/zip_rules.json";
const CN_ZIP_DATA_URL = process.env.CN_ZIP_DATA_URL || ""; // e.g., https://your-bucket/zip_rules.json

/* -------------------------
   ZIP DATA (JSON/CSV)
-------------------------- */
let ZIP_TABLE = new Map(); // zip -> { min, fee, lead, lastCall }

const parseCsv = (raw) => {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const obj = {};
    header.forEach((h, i) => (obj[h] = cols[i]));
    return obj;
  });
};

const normHeaders = (row) => {
  const nk = (k) => (k || "").toLowerCase().replace(/\s+/g, "_");
  const o = {};
  for (const [k, v] of Object.entries(row || {})) o[nk(k)] = v;

  const zipcode = o.zipcode ?? o.zip ?? o.postal_code ?? o.postcode ?? o.code ?? o.zip_code;
  const min = o.delivery_minimum ?? o.minimum ?? o.min ?? o.min_order ?? o.delivery_min;
  const fee = o.delivery_fee ?? o.fee ?? o.delivery_cost ?? o.service_fee;
  const lead = o.lead_time ?? o.lead ?? o.eta ?? o.lead_minutes; // minutes (number)
  const last = o.last_call ?? o.last_call_minutes;               // minutes (number)
  return { zipcode, min, fee, lead, lastCall: last };
};

async function loadZipTableFromFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();
  return parseZipTable(raw, ext);
}

async function loadZipTableFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch ${url} failed: ${r.status}`);
  const raw = await r.text();
  // guess extension from URL
  const ext = url.toLowerCase().includes(".csv") ? ".csv" : ".json";
  return parseZipTable(raw, ext);
}

function parseZipTable(raw, ext) {
  const map = new Map();
  if (ext === ".json") {
    const data = JSON.parse(raw);
    const rows = Array.isArray(data)
      ? data
      : Object.entries(data).map(([zipcode, v]) => ({ zipcode, ...v }));
    for (const r of rows) {
      const { zipcode, min, fee, lead, lastCall } = normHeaders(r);
      const z = String(zipcode || "").replace(/\D/g, "");
      if (!/^\d{5}$/.test(z)) continue;
      const m = parseFloat(min);
      const f = parseFloat(fee);
      const ld = lead != null ? parseFloat(lead) : null;
      const lc = lastCall != null ? parseFloat(lastCall) : null;
      if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
      map.set(z, { min: m, fee: f, lead: ld, lastCall: lc });
    }
  } else if (ext === ".csv") {
    const rows = parseCsv(raw);
    for (const r of rows) {
      const { zipcode, min, fee, lead, lastCall } = normHeaders(r);
      const z = String(zipcode || "").replace(/\D/g, "");
      if (!/^\d{5}$/.test(z)) continue;
      const m = parseFloat(min);
      const f = parseFloat(fee);
      const ld = lead != null ? parseFloat(lead) : null;
      const lc = lastCall != null ? parseFloat(lastCall) : null;
      if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
      map.set(z, { min: m, fee: f, lead: ld, lastCall: lc });
    }
  } else {
    throw new Error(`Unsupported data type "${ext}" (use .json or .csv)`);
  }
  return map;
}

async function bootZipTable() {
  try {
    if (CN_ZIP_DATA_URL) {
      ZIP_TABLE = await loadZipTableFromUrl(CN_ZIP_DATA_URL);
      console.log(`ZIP table loaded from URL (${CN_ZIP_DATA_URL}) — rows: ${ZIP_TABLE.size}`);
    } else {
      ZIP_TABLE = await loadZipTableFromFile(CN_ZIP_DATA_PATH);
      console.log(`ZIP table loaded from file (${CN_ZIP_DATA_PATH}) — rows: ${ZIP_TABLE.size}`);
    }
  } catch (e) {
    console.error("Failed to load ZIP table:", e.message);
    ZIP_TABLE = new Map();
  }
}

/* -------------------------
   DELIVERY TIME TEXT
-------------------------- */
// Map numeric lead to your friendly strings.
// Tweak this mapping if you want different thresholds.
function makeDeliveryTime(row) {
  const lead = Number.isFinite(row?.lead) ? row.lead : null;

  // Your requested phrasing buckets:
  //  - 30–120 mins → "Generally 1 hour to 2 hours"
  //  - 90–150 mins → "Generally 1 and a half hours to 2 and a half hours"
  //  - 0 or unknown → "Generally 30 min to 2 hours"
  if (lead == null || lead === 0) return "Generally 30 min to 2 hours";
  if (lead <= 30) return "Generally 1 hour to 2 hours";
  if (lead >= 90) return "Generally 1 and a half hours to 2 and a half hours";
  // mid-range default
  return "Generally 1 hour to 2 hours";
}

/* -------------------------
   BUILD JSON RESPONSES
-------------------------- */
function buildZipRecord(zip) {
  const z = String(zip).replace(/\D/g, "");
  const row = ZIP_TABLE.get(z);
  if (!row) return null;
  return {
    zip: z,
    fee: Number(row.fee),
    minimum: Number(row.min),
    deliveryTime: makeDeliveryTime(row),
  };
}

function buildZipArray(zips) {
  const seen = new Set();
  const out = [];
  for (const raw of zips) {
    const z = String(raw).replace(/\D/g, "");
    if (!/^\d{5}$/.test(z) || seen.has(z)) continue;
    const rec = buildZipRecord(z);
    if (rec) {
      out.push(rec);
      seen.add(z);
    }
  }
  return out;
}

/* -------------------------
   TwiML: KEEPING YOUR STYLE
-------------------------- */
// Your Twilio webhook that serves TwiML using <ConversationRelay ... />
app.post("/twilio/voice", (req, res) => {
  // IMPORTANT: Conversation Relay requires WSS URL
  const relayUrl = WS_RELAY_PUBLIC_URL || "wss://crystal-nugs-voice-ai.onrender.com/relay";

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `  <Connect>` +
    `    <ConversationRelay` +
    `      url="${relayUrl}"` +
    `      ttsProvider="${TTS_PROVIDER}"` +
    `      voice="${TTS_VOICE}"` +
    `      welcomeGreeting="${escapeXml(WELCOME_GREETING)}" />` +
    `  </Connect>` +
    `</Response>`;

  res.type("text/xml").send(twiml);
});

function escapeXml(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* -------------------------
   JSON API (optional)
-------------------------- */
// POST { "zips": ["94203","95610", ...] } → returns array of {zip,fee,minimum,deliveryTime}
app.post("/intent/zip-batch", (req, res) => {
  const zips = Array.isArray(req.body?.zips) ? req.body.zips : [];
  if (!zips.length) return res.status(400).json({ ok: false, error: "Provide zips: string[]" });
  const data = buildZipArray(zips);
  if (!data.length) return res.status(404).json({ ok: false, error: "No matching zips" });
  return res.json(data);
});

/* -------------------------
   ADMIN: HOT RELOAD
-------------------------- */
app.post("/admin/reload-zips", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    await bootZipTable();
    return res.json({ ok: true, rows: ZIP_TABLE.size });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------------------------
   HEALTH
-------------------------- */
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    relay: WS_RELAY_PUBLIC_URL || null,
    rows: ZIP_TABLE.size,
  })
);

/* -------------------------
   WEBSOCKET: /relay
-------------------------- */
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  // If you want: send a system hello
  // ws.send(JSON.stringify({ type: "system", event: "connected" }));

  ws.on("message", async (data) => {
    // Conversation Relay sends JSON lines—adjust as needed for your setup.
    let text = "";
    try {
      const obj = JSON.parse(data.toString());
      // common shapes: { type:'user', content:'...' } or { text:'...' }
      text = obj?.content || obj?.text || obj?.utterance || String(data || "");
    } catch {
      text = data.toString();
    }

    const t = String(text || "").trim().toLowerCase();

    // Collect all 5-digit zips
    const zipMatches = t.match(/\b\d{5}\b/g) || [];
    const asksDelivery =
      /(delivery|deliver|minimum|min|fee|cost|lead ?time|eta|how long|time|timing)/.test(t);

    if (zipMatches.length && asksDelivery) {
      const payload = buildZipArray(zipMatches);
      if (payload.length) {
        // Many Relay setups accept plain text; we’ll send JSON string to be explicit
        ws.send(JSON.stringify(payload));
        return; // handled locally, don't forward to any LLM
      }
    }

    // Otherwise: echo back minimal “not understood” or pass-through
    // If you have an LLM/Agent layer, call it here and ws.send its response.
    // For now, we keep it quiet to let your welcomeGreeting do the work.
  });
});

/* -------------------------
   HTTP → WS Upgrade
-------------------------- */
const server = app.listen(PORT, async () => {
  await bootZipTable();
  console.log(`Crystal Nugs Voice AI listening on :${PORT}`);
  console.log(`Conversation Relay WS: ${WS_RELAY_PUBLIC_URL || "(set WS_RELAY_PUBLIC_URL)"}`);
});

server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://localhost").pathname === "/relay") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});
