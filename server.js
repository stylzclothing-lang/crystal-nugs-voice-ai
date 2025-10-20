// server.js — Crystal Nugs Voice AI
// Twilio Conversation Relay (TEXT) + Local intents + OpenAI Chat (fallback)

import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import { config } from "dotenv";
import twilio from "twilio";
import fetch from "node-fetch";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

// ===== Business facts (editable via Render Environment) =====
const CN_BRAND    = process.env.CN_BRAND    || "Crystal Nugs";
const CN_ADDRESS  = process.env.CN_ADDRESS  || "2300 J Street, Sacramento, CA 95816";
const CN_HOURS    = process.env.CN_HOURS    || "Our dispensary is open daily from 9:00 AM to 9:00 PM, and we take delivery orders from 8:30 AM to 8:30 PM.";
const CN_ID_RULES = process.env.CN_ID_RULES || "You’ll need a valid government-issued photo ID and be at least 21+.";
const CN_DELIVERY = process.env.CN_DELIVERY || "We deliver to Midtown and the greater Sacramento area, including Citrus Heights, Roseville, Lincoln, Folsom, Elk Grove, and more. Share your address to confirm.";
const CN_PAYMENT  = process.env.CN_PAYMENT  || "We accept cash and JanePay for both in-store and delivery orders. And if you need cash, no worries — we’ve got two ATMs right inside the dispensary.";
const CN_SPECIALS = process.env.CN_SPECIALS || "To check out today’s deals, just visit crystalnugs dot com. The latest specials will show up automatically. Our deals change every single day — so be sure to take advantage while they last.";
const TRANSFER_NUMBER = process.env.TWILIO_VOICE_FALLBACK || "+19165071099";

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY not set — only local intents will answer.");
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- Voice Webhook (Conversation Relay) ----------
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Welcome to Crystal Nugs, Sacramento's only 5-star Dispensary. I can help with delivery areas, store hours, delivery minimums, frequently asked questions or delivery order lookups. What can I do for you today?";
  const twiml =
    "<Response>" +
      "<Connect>" +
        `<ConversationRelay url="${wsUrl}" welcomeGreeting="${escapeXml(greeting)}"/>` +
      "</Connect>" +
    "</Response>";
  res.type("text/xml").send(twiml);
});

// ---------- Optional live transfer ----------
app.post("/twilio/transfer", (_req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say("No problem. Transferring you to a live budtender now.");
  twiml.dial(TRANSFER_NUMBER);
  res.type("text/xml").send(twiml.toString());
});

// ---------- Optional call status logs ----------
app.post("/twilio/status", (req, res) => {
  console.log("Call status:", req.body?.CallStatus, req.body?.CallSid);
  res.sendStatus(200);
});

// ---------- Start HTTP ----------
const server = app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

// ---------- WebSocket bridge: Twilio CR <-> Local intents / OpenAI Chat ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (HTTPS Chat + local intents)");

  twilioWS.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "setup") {
      console.log("CR setup:", msg.sessionId, msg.callSid || "");
      return;
    }

    if (msg.type === "prompt" && msg.voicePrompt) {
      const userText = (msg.voicePrompt || "").trim();
      console.log("Caller said:", userText);

      // 1) Local intents first (fast, accurate, zero cost)
      const local = handleLocalIntent(userText);
      if (local) {
        safeSend(twilioWS, { type: "text", token: local, last: true });
        console.log("Replied (local intent).");
        return;
      }

      // 2) Fallback to OpenAI Chat (if available)
      if (!OPENAI_API_KEY) {
        const sorry =
          "Sorry, I’m having trouble reaching our assistant right now. You can ask about store hours, our address, ID rules, or delivery areas.";
        safeSend(twilioWS, { type: "text", token: sorry, last: true });
        return;
      }

      try {
        const answer = await askOpenAI(userText);
        safeSend(twilioWS, { type: "text", token: answer, last: true });
        console.log("Replied with", Math.min(answer.length, 120), "chars");
      } catch (e) {
        console.error("OpenAI HTTPS error:", e?.message || e);
        // Graceful fallback using your facts
        const fallback =
          `${CN_HOURS} Our address is ${CN_ADDRESS}. ${CN_ID_RULES} ${CN_DELIVERY}`;
        safeSend(twilioWS, { type: "text", token: fallback, last: true });
      }
      return;
    }

    if (msg.type === "interrupt") {
      console.log("Caller interrupted playback");
      return;
    }

    if (msg.type === "dtmf") {
      console.log("DTMF:", msg.digit);
      return;
    }

    if (msg.type === "error") {
      console.error("CR error:", msg.description || msg);
      return;
    }

    if (msg.type) console.log("CR event:", msg.type);
  });

  twilioWS.on("close", () => {
    console.log("Twilio disconnected");
  });
});

// ---------- Local Intent Handler ----------
function handleLocalIntent(text) {
  const q = (text || "").toLowerCase();

  // Hours
  if (/\bhours?\b|\bopen\b|\bclose\b|\bopening\b|\bclosing\b/.test(q)) {
    return `${CN_HOURS} Anything else I can help with?`;
  }

  // Address / location
  if (/\baddress\b|\blocation\b|\bwhere (are|r) (you|u)\b|\bstore\b/.test(q)) {
    return `Our address is ${CN_ADDRESS}. Would you like directions?`;
  }

  // ID / age rules
  if (/\bid\b|\bage\b|\b21\b|\bidentification\b/.test(q)) {
    return `${CN_ID_RULES} Do you want help finding something specific today?`;
  }

  // Delivery zones / areas / ETA
  if (/\bdeliver(y|ies)?\b|\bzone(s)?\b|\barea(s)?\b|\bhow far\b|\bdeliver to\b/.test(q)) {
    return `${CN_DELIVERY} Want me to check if your address is in range?`;
  }

 // Payments
 if (/\b(pay|payment|payments|cash|debit|card|janepay|jane pay|atm|atms)\b/.test(q)) {
  return `${CN_PAYMENT} Anything else I can help with?`;
}

 // Deals / specials / loyalty
 if (/\b(deal|deals|special|specials|discount|discounts|promo|promos|loyalty|rewards)\b/.test(q)) {
  return `${CN_SPECIALS} Want me to text you the link?`;
}

  // Human transfer
  if (/\b(human|agent|person|representative|budtender|staff|someone)\b|\btransfer\b|\btalk to\b/.test(q)) {
    return `No problem — transferring you now.`;
  }

  // Unknown: let model handle
  return null;
}

// ---------- OpenAI HTTPS helper ----------
const SYSTEM_PROMPT =
  `You are the ${CN_BRAND} Sacramento voice assistant. ` +
  `Be concise, friendly, and accurate. ` +
  `${CN_HOURS} ` +
  `ID rules: ${CN_ID_RULES} ` +
  `Delivery: ${CN_DELIVERY} ` +
  `Avoid medical claims and payments by phone. ` +
  `If the caller asks to speak to a person, say "No problem — transferring you now" and stop.`;

async function askOpenAI(userText) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText }
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const content =
    data?.choices?.[0]?.message?.content?.trim?.() ||
    data?.choices?.[0]?.message?.content ||
    "";
  return content || "Sorry, I didn’t catch that.";
}

// ---------- Utils ----------
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {
    console.error("WS send error:", e?.message || e);
  }
}

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
