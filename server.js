// server.js — Crystal Nugs Voice AI (keep ConversationRelay welcomeGreeting)
// Adds local ZIP intent: returns JSON [{zip, fee, minimum, deliveryTime}] or spoken line
// Uses your existing TwiML pattern and a WS endpoint at /relay

import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import fs from "fs/promises";
import path from "path";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* =========================
   ENV / CONFIG
   ========================= */
const PORT = process.env.PORT || 8080;

// Public base. You already have PUBLIC_BASE_URL in your env list.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://crystal-nugs-voice-ai.onrender.com").replace(/\/$/, "");

// Conversation Relay WS URL (wss). If not set, derive from PUBLIC_BASE_URL.
const RELAY_PATH = process.env.TWILIO_WS_RELAY_PATH || "/relay";
const TWILIO_RELAY_WSS_URL =
  process.env.TWILIO_RELAY_WSS_URL || `${PUBLIC_BASE_URL.replace(/^http/, "wss")}${RELAY_PATH}`;

// TwiML voice + greeting kept on the <ConversationRelay> element (like your working setup)
const TTS_PROVIDER = process.env.TTS_PROVIDER || "Google";
const TTS_VOICE = process.env.TTS_VOICE || "en-US-Wavenet-F";
const WELCOME_GREETING =
  process.env.WELCOME_GREETING ||
  "Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?";

// Optional OpenAI fallback (not required)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

// JSON vs speech output for local ZIP intent
const OUTPUT_JSON = String(process.env.CN_OUTPUT_FORMAT || "speech").toLowerCase() === "json";

// Where to load your zone data
const CN_ZIP_DATA_PATH = process.env.CN_ZIP_DATA_PATH || "./data/zip_rules.json";

/* =========================
   ZIP DATA LOADER (JSON/CSV)
   Expected columns/keys (case-insensitive):
   zipcode, delivery_minimum, delivery_fee, lead_time (mins), last_call (mins)
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

  const zipcode = o.zipcode ?? o.zip ?? o.postal_code ?? o.postcode ?? o.code ?? o["zip_code"];
  const min = o.delivery_minimum ?? o.minimum ?? o.min ?? o.min_order;
  const fee = o.delivery_fee ?? o.fee ?? o.delivery_cost;
  const lead = o.lead_time ?? o.lead ?? o.eta ?? o["lead_minutes"];
  const last = o.last_call ?? o["last_call_minutes"];
  return { zipcode, min, fee, lead, lastCall: last };
};

async function loadZipTable(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();
  const map = new Map();

  if (ext === ".json") {
    const data = JSON.parse(raw);
    const rows = Array.isArray(data)
      ? data
      : Object.entries(data).map(([zipcode, v]) => ({ zipcode, ...v }));
    for (const r of rows) {
      const { zipcode, min, fee, lead, lastCall } = normHeaders(r);
      const z = String(zipcode || "").replace(/\D/g, "");
      if (!z) continue;
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
      if (!z) continue;
      const m = parseFloat(min);
      const f = parseFloat(fee);
      const ld = lead != null ? parseFloat(lead) : null;
      const lc = lastCall != null ? parseFloat(lastCall) : null;
      if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
      map.set(z, { min: m, fee: f, lead: ld, lastCall: lc });
    }
  } else {
    console.warn(`Unsupported CN_ZIP_DATA_PATH: ${ext}. Use .json or .csv`);
  }

  ZIP_TABLE = map;
  console.log(`ZIP table loaded: ${ZIP_TABLE.size} rows from ${CN_ZIP_DATA_PATH}`);
}

function zipDashed(zip) {
  return String(zip).replace(/\D/g, "").split("").join("-");
}

// Map a numeric lead (mins) to your phrasing
function deliveryTimeFromLead(lead) {
  if (!Number.isFinite(lead) || lead <= 0) return "Generally 30 min to 2 hours";
  if (lead <= 30) return "Generally 1 hour to 2 hours";
  if (lead <= 45) return "Generally 1 and a half hours to 2 and a half hours";
  return "Generally 1 hour to 2 hours";
}

function buildZipJSON(zip) {
  const z = String(zip).replace(/\D/g, "");
  const row = ZIP_TABLE.get(z);
  if (!row) return null;
  return {
    zip: z,
    fee: Number(row.fee),
    minimum: Number(row.min),
    deliveryTime: deliveryTimeFromLead(row.lead),
  };
}

function buildZipSpoken(zip) {
  const item = buildZipJSON(zip);
  if (!item) return `For zip code ${zipDashed(zip)}, I couldn't find a delivery zone. Can you try another zip code?`;
  return `For zip code ${zipDashed(item.zip)}, the delivery minimum is $${item.minimum}, the delivery fee is $${item.fee.toFixed(
    2
  )}, and the delivery time is ${item.deliveryTime}.`;
}

/* =========================
   Twilio TwiML — keep your working pattern
   <Connect><ConversationRelay url="wss://.../relay" ttsProvider="Google" voice="en-US-Wavenet-F" welcomeGreeting="..."/>
   ========================= */
app.post("/twilio/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  connect.conversationRelay({
    url: TWILIO_RELAY_WSS_URL,
    ttsProvider: TTS_PROVIDER,
    voice: TTS_VOICE,
    welcomeGreeting: WELCOME_GREETING,
  });
  res.type("text/xml").send(vr.toString());
});

/* =========================
   Optional transfer endpoint (unchanged from your setup if you have one)
   ========================= */
app.post("/twilio/transfer", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("Transferring you now.");
  const dial = vr.dial({ callerId: req.body?.To || undefined });
  dial.number(process.env.TWILIO_VOICE_FALLBACK || "+19165071099");
  res.type("text/xml").send(vr.toString());
});

/* =========================
   REST helper: batch zone lookup
   GET /zones?zips=95827,95632,95758
   ========================= */
app.get("/zones", (req, res) => {
  const q = String(req.query.zips || "");
  const list = (q.match(/\b\d{5}\b/g) || []).map(buildZipJSON).filter(Boolean);
  res.json(list);
});

/* =========================
   WebSocket: /relay — local intent for ZIPs
   - Detects any 5-digit ZIP(s) and delivery keywords
   - Returns JSON array when CN_OUTPUT_FORMAT=json
   - Else returns a spoken sentence for the first ZIP
   ========================= */
const wss = new WebSocketServer({ noServer: true });

function extractText(payload) {
  // Try common shapes, else treat as raw text
  try {
    const obj = JSON.parse(payload.toString());
    return obj?.content || obj?.text || obj?.utterance || payload.toString();
  } catch {
    return payload.toString();
  }
}

wss.on("connection", (ws, req) => {
  console.log("Twilio connected to Conversation Relay (WS):", req.url);

  ws.on("message", async (data) => {
    const text = extractText(data);
    const t = String(text || "").trim().toLowerCase();

    // Delivery intent detector
    const asksDelivery = /(delivery|deliver|minimum|min|fee|cost|lead ?time|eta|how long)/.test(t);
    const zips = [...new Set((t.match(/\b\d{5}\b/g) || []))];

    if (asksDelivery && zips.length) {
      const items = zips.map(buildZipJSON).filter(Boolean);

      if (!items.length) {
        return ws.send(OUTPUT_JSON ? JSON.stringify([]) : "I couldn't find those zip codes. Can you try another?");
      }

      if (OUTPUT_JSON) {
        return ws.send(JSON.stringify(items));
      } else {
        // speak just the first; (you can loop if desired)
        return ws.send(buildZipSpoken(items[0].zip));
      }
    }

    // Not a local ZIP intent: do nothing (let your upstream flow handle it).
    // If you want a fallback prompt, uncomment:
    // ws.send("I can help with delivery minimums, delivery fees, and delivery times if you tell me a 5-digit zip code.");
  });

  ws.on("close", (code, reason) => {
    console.log("Twilio WS closed:", code, reason?.toString?.() || "");
  });
});

// HTTP → WS upgrade only for /relay
const server = app.listen(PORT, async () => {
  await loadZipTable(CN_ZIP_DATA_PATH).catch((e) => console.error(e));
  console.log(`Crystal Nugs Voice AI on :${PORT}`);
  console.log(`Relay (wss): ${TWILIO_RELAY_WSS_URL}`);
});

server.on("upgrade", (request, socket, head) => {
  if (request.url && request.url.startsWith(RELAY_PATH)) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

/* =========================
   Health
   ========================= */
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    relayPath: RELAY_PATH,
    relayWSS: TWILIO_RELAY_WSS_URL,
    dataFile: CN_ZIP_DATA_PATH,
    zipCount: ZIP_TABLE.size,
    outputFormat: OUTPUT_JSON ? "json" : "speech",
  })
);
