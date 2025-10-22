// server.js — Crystal Nugs Voice AI (ESM, Twilio ConversationRelay compatible)
// - TwiML with <ConversationRelay ... welcomeGreeting="...">
// - WebSocket replies as: { type: "text", token: "...", last: true }
// - ZIP data from local JSON (CN_ZIP_DATA_PATH, e.g., ./data/zipzones.json)
// - Answers: delivery minimum/fee/timing; hours/address/phone/website; safe fallback
// - Admin: POST /admin/reload-zips  (Authorization: Bearer ADMIN_TOKEN)

import express from "express";
import bodyParser from "body-parser";
import "dotenv/config.js";
import { WebSocketServer } from "ws";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/* =========================
   Setup
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 8080;

// Public base and relay URL (keep your existing greeting flow)
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const WS_RELAY_PUBLIC_URL =
  process.env.WS_RELAY_PUBLIC_URL ||
  (APP_BASE_URL ? APP_BASE_URL.replace(/^http/, "wss") + "/relay" : "");

// TTS for TwiML attributes (Relay handles actual speaking)
const TTS_PROVIDER = process.env.TWILIO_TTS_PROVIDER || "Google";
const TTS_VOICE = process.env.TWILIO_TTS_VOICE || "en-US-Wavenet-F";
const WELCOME_GREETING =
  process.env.CN_WELCOME ||
  'Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Local ZIP data file path (in your repo: ./data/zipzones.json)
const CN_ZIP_DATA_PATH = process.env.CN_ZIP_DATA_PATH || "./data/zipzones.json";

// Common info (these can already be set in your env)
const CN_HOURS = process.env.CN_HOURS || "We’re open daily; last call is ~90 minutes before close.";
const CN_ADDRESS = process.env.CN_ADDRESS || "2300 J Street, Sacramento, CA 95816";
const CN_PHONE = process.env.CN_PHONE || "+1 (916) 507-XXXX";
const CN_WEBSITE = process.env.CN_WEBSITE || "crystalnugs.com";

/* =========================
   ZIP DATA
========================= */
let ZIP_TABLE = new Map(); // zip -> { min, fee, lead, lastCall }

function normalizeRow(row) {
  // normalize keys to snake_case
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

async function bootZipTable() {
  try {
    const abs = path.resolve(__dirname, CN_ZIP_DATA_PATH);
    const raw = await fs.readFile(abs, "utf8");
    const ext = path.extname(abs).toLowerCase() || ".json";
    if (ext !== ".json") throw new Error(`Only .json is supported for CN_ZIP_DATA_PATH (got ${ext})`);

    const data = JSON.parse(raw);
    const rows = Array.isArray(data)
      ? data
      : Object.entries(data).map(([zipcode, v]) => ({ zipcode, ...v }));

    const map = new Map();
    for (const r of rows) {
      const { zipcode, min, fee, lead, lastCall } = normalizeRow(r);
      const z = String(zipcode || "").replace(/\D/g, "");
      if (!/^\d{5}$/.test(z)) continue;
      const m = parseFloat(min);
      const f = parseFloat(fee);
      const ld = lead != null ? parseFloat(lead) : null;
      const lc = lastCall != null ? parseFloat(lastCall) : null;
      if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
      map.set(z, { min: m, fee: f, lead: ld, lastCall: lc });
    }

    ZIP_TABLE = map;
    console.log(`ZIP table loaded from file: ${CN_ZIP_DATA_PATH} — rows: ${ZIP_TABLE.size}`);
  } catch (e) {
    console.error("Failed to load ZIP table:", e.message);
    ZIP_TABLE = new Map();
  }
}

/* =========================
   Helpers
========================= */
function deliveryTimeText(row) {
  const lead = Number.isFinite(row?.lead) ? row.lead : null;
  if (lead == null || lead === 0) return "Generally 30 min to 2 hours";
  if (lead <= 30) return "Generally 1 hour to 2 hours";
  if (lead >= 90) return "Generally 1 and a half hours to 2 and a half hours";
  return "Generally 1 hour to 2 hours";
}

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
    if (rec) { out.push(rec); seen.add(z); }
  }
  return out;
}

function hyphenatedZip(zip) {
  return String(zip).split("").join("-");
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
  res.json({ ok: true, relay: WS_RELAY_PUBLIC_URL || null, rows: ZIP_TABLE.size })
);

/* =========================
   WEBSOCKET (Conversation Relay)
========================= */
// Twilio Conversation Relay expects outbound "speak" messages as:
//   { type: "text", token: "...", last: true }
const wss = new WebSocketServer({ noServer: true });

function say(socket, text, { last = true, lang } = {}) {
  const payload = { type: "text", token: String(text ?? ""), last: Boolean(last) };
  if (lang) payload.lang = lang; // optional
  try {
    socket.send(JSON.stringify(payload));
    console.log("[WS OUT]", payload);
  } catch (e) {
    console.error("WS send error:", e);
  }
}

wss.on("connection", (socket) => {
  console.log("[WS] connected");

  socket.on("message", async (data) => {
    const raw = data.toString();
    console.log("[WS IN]", raw);

    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "setup") return;

    if (msg.type === "prompt") {
      const text = String(msg.voicePrompt || "").trim();
      const t = text.toLowerCase();

      // Delivery / ZIP intent
      const zips = t.match(/\b\d{5}\b/g) || [];
      const asksDelivery =
        /(delivery|deliver|minimum|min|fee|cost|lead ?time|eta|how long|time|timing)/.test(t);

      if (zips.length && asksDelivery) {
        const arr = buildZipArray(zips);
        if (arr.length) {
          if (arr.length === 1) {
            const r = arr[0];
            const spokenZip = hyphenatedZip(r.zip); // "9-5-8-2-7"
            say(
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
            say(socket, `I found ${arr.length} zip codes. ${first}.`);
          }
          return;
        } else {
          say(socket, "I couldn't find that delivery zone. Try another zip code.");
          return;
        }
      }

      // Hours / Address / Phone / Website quick intents
      if (/\bhour|open|close|closing|last call\b/.test(t)) {
        say(socket, CN_HOURS);
        return;
      }
      if (/\baddress|location|where\b/.test(t)) {
        say(socket, CN_ADDRESS);
        return;
      }
      if (/\bphone|call|number\b/.test(t)) {
        say(socket, `Our phone number is ${CN_PHONE}.`);
        return;
      }
      if (/\bwebsite|site|url\b/.test(t)) {
        say(socket, `Our website is ${CN_WEBSITE}.`);
        return;
      }

      // Fallback — never silent
      say(
        socket,
        "I can help with delivery minimums, fees, and timing for any zip code. Try saying, delivery minimum for nine five eight two seven."
      );
      return;
    }

    if (msg.type === "error") {
      // Relay internal notices (we don't need to answer here)
      console.warn("[WS ERROR from Relay]", msg.description);
      return;
    }
  });

  socket.on("close", (code, reason) => {
    console.log("[WS] closed", code, reason?.toString());
  });
});

/* =========================
   HTTP → WS upgrade
========================= */
const server = app.listen(PORT, async () => {
  await bootZipTable();
  console.log(`Server :${PORT}`);
  console.log(`Relay WS public URL: ${WS_RELAY_PUBLIC_URL || "(set WS_RELAY_PUBLIC_URL)"}`);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/relay") {
    wss.handleUpgrade(request, socket, head, (conn) => {
      wss.emit("connection", conn, request);
    });
  } else {
    socket.destroy();
  }
});
