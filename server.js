// server.js — Crystal Nugs Voice AI (Conversation Relay with auto-negotiated reply schema)
// - Keeps your <ConversationRelay ... welcomeGreeting="...">
// - Answers ZIP min/fee/time from /data/zipzones.json (or CN_ZIP_DATA_URL)
// - Auto-detects which outbound payload schema your Relay expects:
//     Tries formats in order until Relay stops sending 64107 errors, then sticks with it.
// - Never silent: always responds to prompt events.

import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import * as WS from "ws";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

config();

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

// Non-zip quick answers
const CN_HOURS = process.env.CN_HOURS || "We’re open daily; last call is ~90 minutes before close.";
const CN_ADDRESS = process.env.CN_ADDRESS || "2300 J Street, Sacramento, CA 95816";
const CN_PHONE = process.env.CN_PHONE || "+1 (916) 507-XXXX";
const CN_WEBSITE = process.env.CN_WEBSITE || "crystalnugs.com";

/* =========================
   ZIP DATA
========================= */
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
  const lead = o.lead_time ?? o.lead ?? o.eta ?? o.lead_minutes; // minutes
  const last = o.last_call ?? o.last_call_minutes;
  return { zipcode, min, fee, lead, lastCall: last };
};

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
  const r = await fetch(url);
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
