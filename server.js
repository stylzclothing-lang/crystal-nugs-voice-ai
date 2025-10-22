// server.js — Crystal Nugs Voice AI — SSML digit ZIP + external ZIP rules (JSON/CSV)
// Twilio Conversation Relay + Local intents + OpenAI fallback
// © Crystal Nugs

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import bodyParser from "body-parser";
import { config } from "dotenv";
import twilio from "twilio";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* =========================
   ENV + CONSTANTS
   ========================= */
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

const TRANSFER_NUMBER = process.env.TWILIO_VOICE_FALLBACK || "+19165071099";
const USE_SSML = String(process.env.CN_USE_SSML || "false").toLowerCase() === "true";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_APP_BASE = process.env.APP_BASE_URL || "https://your-app.example.com";
const TWILIO_WS_RELAY_URL =
  process.env.TWILIO_WS_RELAY_URL || `${TWILIO_APP_BASE.replace(/\/$/, "")}/ws/relay`;

const CN_ZIP_DATA_PATH = process.env.CN_ZIP_DATA_PATH || "./data/zip_rules.json";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // for /admin/reload-zips

const HOURS =
  process.env.CN_HOURS ||
  "Mon–Sun 9am–9pm (Delivery last call 90 minutes before close).";
const BRAND = process.env.CN_BRAND || "Crystal Nugs Dispensary, 2300 J Street, Sacramento";

// SSML allow-list
const ALLOW_SSML_TAGS = new Set(["speak", "say-as", "break"]);

/* =========================
   SSML / OUTPUT HELPERS
   ========================= */
const speak = (text) => (USE_SSML ? `<speak>${text}</speak>` : text);

const zipForVoice = (zip) => {
  const z = String(zip).replace(/\D/g, "");
  if (!z) return USE_SSML ? `<say-as interpret-as="digits">00000</say-as>` : "0-0-0-0-0";
  return USE_SSML ? `<say-as interpret-as="digits">${z}</say-as>` : z.split("").join("-");
};

const sanitize = (str) => {
  if (!str) return "";
  if (!USE_SSML) return String(str).replace(/<[^>]+>/g, "");
  return String(str).replace(/<([^/\s>]+)([^>]*)>|<\/([^>]+)>/g, (m, openTag, attrs, closeTag) => {
    const tag = (openTag || closeTag || "").toLowerCase();
    return ALLOW_SSML_TAGS.has(tag) ? m : "";
  });
};

const beat = (ms = 150) => (USE_SSML ? `<break time="${ms}ms"/>` : " ");

/* =========================
   ZIP RULES: LOAD FROM FILE
   ========================= */

let ZIP_RULES = new Map(); // zip -> { min, fee }
const DEFAULT_ZONE = { min: 80, fee: 1.99 };

const parseCsv = (raw) => {
  // very light CSV parser (commas). Accepts headers.
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    const obj = {};
    header.forEach((h, i) => (obj[h] = cols[i]));
    return obj;
  });
  return rows;
};

const normalizeHeaders = (obj) => {
  // map various header spellings to {zipcode, min, fee}
  const mapKey = (k) => (k || "").toLowerCase().replace(/\s+/g, "_");
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[mapKey(k)] = v;
  }

  const z =
    out.zipcode ?? out.zip ?? out.postal_code ?? out.postcode ?? out.code ?? out["zip_code"];
  const min =
    out.delivery_minimum ??
    out.minimum ??
    out.min ??
    out.min_order ??
    out["delivery_min"] ??
    out["min_delivery"];
  const fee =
    out.delivery_fee ?? out.fee ?? out["delivery_cost"] ?? out["service_fee"] ?? out["d_fee"];

  return { zipcode: z, min, fee };
};

async function loadZipRulesFromFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();

  const map = new Map();

  if (ext === ".json") {
    const data = JSON.parse(raw);
    // Accept array of objects or object keyed by zip
    if (Array.isArray(data)) {
      for (const row of data) {
        const { zipcode, min, fee } = normalizeHeaders(row);
        const z = String(zipcode || "").replace(/\D/g, "");
        if (!z) continue;
        const m = parseFloat(min);
        const f = parseFloat(fee);
        if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
        map.set(z, { min: m, fee: f });
      }
    } else if (data && typeof data === "object") {
      for (const [key, val] of Object.entries(data)) {
        const z = String(key).replace(/\D/g, "");
        if (!z) continue;
        const obj = normalizeHeaders(val);
        const m = parseFloat(obj.min);
        const f = parseFloat(obj.fee);
        if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
        map.set(z, { min: m, fee: f });
      }
    }
  } else if (ext === ".csv") {
    const rows = parseCsv(raw);
    for (const row of rows) {
      const { zipcode, min, fee } = normalizeHeaders(row);
      const z = String(zipcode || "").replace(/\D/g, "");
      if (!z) continue;
      const m = parseFloat(min);
      const f = parseFloat(fee);
      if (!Number.isFinite(m) || !Number.isFinite(f)) continue;
      map.set(z, { min: m, fee: f });
    }
  } else {
    throw new Error(
      `Unsupported CN_ZIP_DATA_PATH extension "${ext}". Use .json or .csv (got: ${abs}).`
    );
  }

  if (map.size === 0) {
    console.warn("ZIP rules file parsed but produced 0 rows. Using empty map.");
  }

  return map;
}

async function bootZipRules() {
  try {
    ZIP_RULES = await loadZipRulesFromFile(CN_ZIP_DATA_PATH);
    console.log(`Loaded ${ZIP_RULES.size} ZIP rules from ${CN_ZIP_DATA_PATH}`);
  } catch (e) {
    console.error("Failed to load ZIP rules:", e.message);
    console.error("Continuing with empty map (DEFAULT_ZONE will apply).");
    ZIP_RULES = new Map();
  }
}

function getZoneInfo(zip) {
  const z = String(zip).replace(/\D/g, "");
  return ZIP_RULES.get(z) || DEFAULT_ZONE;
}

/* =========================
   LOCAL INTENTS
   ========================= */
function buildDeliveryMinResponse(zip) {
  const { min, fee } = getZoneInfo(zip);
  const zipChunk = zipForVoice(zip);
  const msg = `For zip code ${zipChunk}${beat()}the delivery minimum is $${min} and the delivery fee is $${fee.toFixed(
    2
  )}.`;
  return sanitize(speak(msg));
}

app.post("/intent/delivery-minimum", (req, res) => {
  const zipcode = (req.body.zipcode || "").toString();
  if (!zipcode) return res.status(400).json({ ok: false, error: "Missing zipcode" });
  return res.json({
    ok: true,
    speech: buildDeliveryMinResponse(zipcode),
    meta: { zipcode, USE_SSML },
  });
});

/* =========================
   ADMIN: HOT RELOAD ZIPS
   ========================= */
app.post("/admin/reload-zips", async (req, res) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!ADMIN_TOKEN || auth !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const fresh = await loadZipRulesFromFile(CN_ZIP_DATA_PATH);
    ZIP_RULES = fresh;
    return res.json({ ok: true, count: ZIP_RULES.size, file: CN_ZIP_DATA_PATH });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   OPENAI FALLBACK (OPTIONAL)
   ========================= */
async function openAiChat(messages, system = "You are a helpful Crystal Nugs assistant.") {
  if (!OPENAI_API_KEY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        temperature: 0.3,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || "";
    return content;
  } catch (e) {
    console.error("OpenAI error:", e);
    return null;
  }
}

/* =========================
   TWILIO WEBHOOKS (TwiML)
   ========================= */
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

app.post("/twilio/voice", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const welcome = sanitize(
    speak(
      `${BRAND}.${beat(100)} How can I help you today? If you need a person at any time, say "transfer".`
    )
  );

  const connect = vr.connect();
  connect
    .conversationRelay({
      url: TWILIO_WS_RELAY_URL,
    })
    .say({ voice: "Polly.Joanna-Neural" }, welcome);

  res.type("text/xml").send(vr.toString());
});

app.post("/twilio/transfer", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const s = sanitize(speak(`No problem.${beat()}Transferring you now.`));
  vr.say({ voice: "Polly.Joanna-Neural" }, s);
  const dial = vr.dial({ callerId: req.body?.To || undefined });
  dial.number(TRANSFER_NUMBER);
  res.type("text/xml").send(vr.toString());
});

app.post("/twilio/status", (req, res) => {
  try {
    console.log("Call status:", {
      CallSid: req.body.CallSid,
      CallStatus: req.body.CallStatus,
      Direction: req.body.Direction,
      From: req.body.From,
      To: req.body.To,
    });
  } catch (e) {}
  res.sendStatus(200);
});

/* =========================
   WEBSOCKET RELAY (AI Brain)
   ========================= */
const wss = new WebSocketServer({ noServer: true });
const SESSIONS = new Map();

function wsSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error("WS send error:", e);
  }
}

async function handleUserText(ws, text) {
  const t = text.trim().toLowerCase();

  // detect ZIP mentions + delivery questions
  const zipMatch = t.match(/\b(9\d{4}|8\d{4}|7\d{4}|6\d{4}|5\d{4})\b/);
  if (zipMatch && /(delivery.*min|minimum|fee|deliver)/.test(t)) {
    const zip = zipMatch[1];
    const speech = buildDeliveryMinResponse(zip);
    return wsSend(ws, { type: "assistant", modality: "speech", content: speech });
  }

  if (/transfer|human|agent|representative/.test(t)) {
    const msg = sanitize(speak(`No problem.${beat()}Transferring you now.`));
    return wsSend(ws, { type: "assistant", modality: "command", action: "transfer", content: msg });
  }

  if (/hour|open|close|closing|last call/.test(t)) {
    const out = sanitize(speak(`${HOURS}`));
    return wsSend(ws, { type: "assistant", modality: "speech", content: out });
  }

  // fallback to OpenAI
  const ai = await openAiChat([{ role: "user", content: text }], `You are the Crystal Nugs assistant.
- Be concise and friendly.
- If the user mentions a 5-digit number that looks like a ZIP and asks about delivery, respond with the delivery minimum and fee using the format rules:
  * ZIP must be read as digits via <say-as interpret-as="digits"> if SSML is enabled (USE_SSML=${USE_SSML}).
  * Otherwise render as "9-5-8-2-7".
- If the user asks to transfer, reply with a short acknowledgment "Transferring you now." and the client will handle the transfer.`);

  const fallback = ai || "I can help with delivery minimums, hours, and transfers.";
  const safe = sanitize(USE_SSML ? speak(fallback) : fallback);
  return wsSend(ws, { type: "assistant", modality: "speech", content: safe });
}

wss.on("connection", (ws, req) => {
  const id = Math.random().toString(36).slice(2);
  SESSIONS.set(id, ws);
  ws.on("message", async (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return handleUserText(ws, data.toString());
    }

    if (msg?.type === "user") {
      return handleUserText(ws, String(msg.content || ""));
    }

    if (msg?.type === "system" && msg?.event === "start") {
      return wsSend(ws, {
        type: "assistant",
        modality: "speech",
        content: sanitize(speak(`Welcome to ${BRAND}.${beat()}How can I help?`)),
      });
    }
  });

  ws.on("close", () => {
    SESSIONS.delete(id);
  });
});

// HTTP→WS upgrade
const server = app.listen(PORT, async () => {
  await bootZipRules();
  console.log(`Crystal Nugs Voice AI running on :${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (url && url.startsWith("/ws/relay")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

/* =========================
   HEALTH + DIAGNOSTICS
   ========================= */
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "crystal-nugs-voice-ai", zips: ZIP_RULES.size })
);

app.get("/debug/zip/:zip", (req, res) => {
  const { zip } = req.params;
  res.json({
    zip,
    voice_format: sanitize(zipForVoice(zip)),
    message: buildDeliveryMinResponse(zip),
    ssml: USE_SSML,
    zone: getZoneInfo(zip),
    file: CN_ZIP_DATA_PATH,
  });
});
