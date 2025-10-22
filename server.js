// server.js — Crystal Nugs Voice AI (CommonJS build for Render)
// - TwiML with <ConversationRelay ... welcomeGreeting="...">
// - WS: auto-negotiates outbound payload schema to avoid 64107
// - Loads zips from ./data/zipzones.json or CN_ZIP_DATA_URL
// - Answers ZIP min/fee/time; plus hours/address/phone/site; fallback

const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();
const { WebSocketServer } = require("ws");
const fs = require("fs/promises");
const path = require("path");

// Optional fetch for remote data (Node >=18 has global fetch)
async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 8080;

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const WS_RELAY_PUBLIC_URL =
  process.env.WS_RELAY_PUBLIC_URL ||
  (APP_BASE_URL ? APP_BASE_URL.replace(/^http/, "wss") + "/relay" : "");

const TTS_PROVIDER = process.env.TWILIO_TTS_PROVIDER || "Google";
const TTS_VOICE = process.env.TWILIO_TTS_VOICE || "en-US-Wavenet-F";
const WELCOME_GREETING =
  process.env.CN_WELCOME ||
  'Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const CN_ZIP_DATA_PATH = process.env.CN_ZIP_DATA_PATH || "./data/zipzones.json";
const CN_ZIP_DATA_URL = process.env.CN_ZIP_DATA_URL || "";

// Non-zip quick answers (use your existing envs if set)
const CN_HOURS = process.env.CN_HOURS || "We’re open daily; last call is ~90 minutes before close.";
const CN_ADDRESS = process.env.CN_ADDRESS || "2300 J Street, Sacramento, CA 95816";
const CN_PHONE = process.env.CN_PHONE || "+1 (916) 507-XXXX";
const CN_WEBSITE = process.env.CN_WEBSITE || "crystalnugs.com";

/* =========================
   ZIP DATA
========================= */
let ZIP_TABLE = new Map(); // zip -> { min, fee, lead, lastCall }

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const obj = {};
    header.forEach((h, i) => (obj[h] = cols[i]));
    return obj;
  });
}

function normHeaders(row) {
  const nk = (k) => (k || "").toLowerCase().replace(/\s+/g, "_");
  const o = {};
  Object.entries(row || {}).forEach(([k, v]) => (o[nk(k)] = v));

  const zipcode = o.zipcode ?? o.zip ?? o.postal_code ?? o.postcode ?? o.code ?? o.zip_code;
  const min = o.delivery_minimum ?? o.minimum ?? o.min ?? o.min_order ?? o.delivery_min;
  const fee = o.delivery_fee ?? o.fee ?? o.delivery_cost ?? o.service_fee;
  const lead = o.lead_time ?? o.lead ?? o.eta ?? o.lead_minutes;
  const last = o.last_call ?? o.last_call_minutes;
  return { zipcode, min, fee, lead, lastCall: last };
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
    throw new Error(`Unsupported data extension: ${ext} (use .json or .csv)`);
  }
  return map;
}

async function loadZipTableFromFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(abs, "utf8");
  const ext = path.extname(abs).toLowerCase() || ".json";
  return parseZipTable(raw, ext);
}

async function loadZipTableFromUrl(url) {
  const $fetch = await getFetch();
  const r = await $fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  const raw = await r.text();
  const ext = url.toLowerCase().includes(".csv") ? ".csv" : ".json";
  return parseZipTable(raw, ext);
}

async function bootZipTable() {
  try {
    if (CN_ZIP_DATA_URL) {
      ZIP_TABLE = await loadZipTableFromUrl(CN_ZIP_DATA_URL);
      console.log(`ZIP table loaded from URL: ${CN_ZIP_DATA_URL} — rows: ${ZIP_TABLE.size}`);
    } else {
      ZIP_TABLE = await loadZipTableFromFile(CN_ZIP_DATA_PATH);
      console.log(`ZIP table loaded from file: ${CN_ZIP_DATA_PATH} — rows: ${ZIP_TABLE.size}`);
    }
  } catch (e) {
    console.error("Failed to load ZIP table:", e.message);
    ZIP_TABLE = new Map();
  }
}

/* =========================
   DELIVERY TIME TEXT
========================= */
function deliveryTimeText(row) {
  const lead = Number.isFinite(row?.lead) ? row.lead : null;
  if (lead == null || lead === 0) return "Generally 30 min to 2 hours";
  if (lead <= 30) return "Generally 1 hour to 2 hours";
  if (lead >= 90) return "Generally 1 and a half hours to 2 and a half hours";
  return "Generally 1 hour to 2 hours";
}

/* =========================
   BUILD RESPONSES
========================= */
function buildZipRecord(zip) {
  const z = String(zip).replace(/\D/g, "");
  const row = ZIP_TABLE.get(z);
  if (!row) return null;
  return {
    zip: z,
    fee: Number(row.fee),
    minimum: Number(row.min),
    deliveryTime: deliveryTimeText(row),
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

/* =========================
   TwiML (Conversation Relay)
========================= */
app.post("/twilio/voice", (req, res) => {
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

/* =========================
   JSON API (batch zips)
========================= */
app.post("/intent/zip-batch", (req, res) => {
  const zips = Array.isArray(req.body?.zips) ? req.body.zips : [];
  if (!zips.length) return res.status(400).json({ ok: false, error: "Provide zips: string[]" });
  const data = buildZipArray(zips);
  if (!data.length) return res.status(404).json({ ok: false, error: "No matching zips" });
  return res.json(data);
});

/* =========================
   ADMIN: Hot reload data
========================= */
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

/* =========================
   HEALTH
========================= */
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    relay: WS_RELAY_PUBLIC_URL || null,
    rows: ZIP_TABLE.size,
  })
);

/* =========================
   WEBSOCKET + AUTO SCHEMA
========================= */
// Candidate outbound formats (ordered). We’ll bump if Relay sends 64107.
const SCHEMAS = [
  (text) => ({ type: "response", voiceResponse: text }),
  (text) => ({ type: "assistant", content: text }),
  (text) => ({ type: "message", message: text }),
  (text) => ({ type: "say", text }),
  (text) => ({ response: text }),
  (text) => ({ type: "response", text }),
  (text) => ({ type: "response", voice_response: text }),
  (text) => ({ speech: text }),
  (text) => text // plain string
];

const wss = new WebSocketServer({ noServer: true });

function connState(socket) {
  if (!socket._state) socket._state = { schemaIndex: 0, lastText: "" };
  return socket._state;
}

function trySend(socket, text, isRetry = false) {
  const state = connState(socket);
  state.lastText = text;

  const build = SCHEMAS[state.schemaIndex] || SCHEMAS[0];
  const payload = build(String(text || ""));
  const wire = typeof payload === "string" ? payload : JSON.stringify(payload);

  try {
    if (typeof socket.send === "function") {
      socket.send(wire);
      console.log("[WS OUT]", typeof payload === "string" ? payload : payload);
    } else {
      console.error("trySend: socket.send is not a function");
    }
  } catch (e) {
    console.error("WS send error:", e);
  }

  if (!isRetry) {
    // errors are handled on 'error' message path from Relay
  }
}

function bumpSchemaAndResend(socket) {
  const state = connState(socket);
  state.schemaIndex = Math.min(state.schemaIndex + 1, SCHEMAS.length - 1);
  console.warn("[SCHEMA] Bumping to index", state.schemaIndex);
  if (state.lastText) trySend(socket, state.lastText, true);
}

wss.on("connection", (socket) => {
  console.log("[WS] connected");

  socket.on("message", async (data) => {
    const raw = data.toString();
    console.log("[WS IN]", raw);

    let msg = {};
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "setup") return;

    if (msg.type === "error") {
      const desc = String(msg.description || "");
      if (desc.includes("Invalid message") || desc.includes("64107")) {
        bumpSchemaAndResend(socket);
      }
      return;
    }

    if (msg.type === "prompt") {
      const text = String(msg.voicePrompt || "").trim();
      const t = text.toLowerCase();

      // Delivery ZIP intent
      const zips = t.match(/\b\d{5}\b/g) || [];
      const asksDelivery =
        /(delivery|deliver|minimum|min|fee|cost|lead ?time|eta|how long|time|timing)/.test(t);

      if (zips.length && asksDelivery) {
        const arr = buildZipArray(zips);
        if (arr.length) {
          if (arr.length === 1) {
            const r = arr[0];
            const spokenZip = r.zip.split("").join(" ");
            trySend(
              socket,
              `For zip code ${spokenZip}, the delivery minimum is $${r.minimum}, the delivery fee is $${r.fee.toFixed(
                2
              )}. ${r.deliveryTime}.`
            );
          } else {
            const first = arr
              .slice(0, 3)
              .map((r) => `${r.zip}: $${r.minimum} min, $${r.fee.toFixed(2)} fee`)
              .join("; ");
            trySend(socket, `I found ${arr.length} zip codes. ${first}.`);
          }
          return;
        } else {
          trySend(socket, "I couldn't find that delivery zone. Try another zip code.");
          return;
        }
      }

      // Hours / Address / Phone / Website
      if (/\bhour|open|close|closing|last call\b/.test(t)) {
        trySend(socket, CN_HOURS);
        return;
      }
      if (/\baddress|location|where\b/.test(t)) {
        trySend(socket, CN_ADDRESS);
        return;
      }
      if (/\bphone|call|number\b/.test(t)) {
        trySend(socket, `Our phone number is ${CN_PHONE}.`);
        return;
      }
      if (/\bwebsite|site|url\b/.test(t)) {
        trySend(socket, `Our website is ${CN_WEBSITE}.`);
        return;
      }

      // Fallback
      trySend(
        socket,
        "I can help with delivery minimums, fees, and timing for any zip code. Try saying, delivery minimum for nine five eight two seven."
      );
      return;
    }
  });

  socket.on("close", (code, reason) => {
    console.log("[WS] closed", code, reason?.toString());
  });
});

/* =========================
   HTTP → WS UPGRADE
========================= */
const server = app.listen(PORT, async () => {
  await bootZipTable();
  console.log(`Server :${PORT}`);
  console.log(`Relay WS public URL: ${WS_RELAY_PUBLIC_URL || "(set WS_RELAY_PUBLIC_URL)"}`);
});

server.on("upgrade", (request, socket, head) => {
  // Render passes only the path (no host), build a URL to get pathname
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/relay") {
    wss.handleUpgrade(request, socket, head, (conn) => {
      wss.emit("connection", conn, request);
    });
  } else {
    socket.destroy();
  }
});
