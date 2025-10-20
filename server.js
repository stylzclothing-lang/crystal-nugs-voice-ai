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
// ---------- Local Intent Router (uses your Render env vars) ----------
function handleLocalIntent(text = "") {
  const q = text.toLowerCase();

  // Helper: build answers from env, with sensible fallbacks
  const HOURS       = process.env.CN_HOURS       || "Our dispensary is open daily from 9:00 AM to 9:00 PM, and we take delivery orders from 8:30 AM to 8:30 PM.";
  const ADDRESS     = process.env.CN_ADDRESS     || "2300 J Street, Sacramento, CA 95816";
  const ID_RULES    = process.env.CN_ID_RULES    || "You’ll need a valid government-issued photo ID and be at least 21+.";
  const DELIVERY    = process.env.CN_DELIVERY    || "We deliver to Midtown and the greater Sacramento area including Citrus Heights, Roseville, Lincoln, Folsom, Elk Grove, and more. Share your address to confirm delivery.";
  const DELIV_MIN   = process.env.CN_DELIVERY_MINIMUM || "Order minimums depend on where you’re located — for the immediate Sacramento area, it’s just $40.";
  const DELIV_FEE   = process.env.CN_DELIVERY_FEE     || "Enjoy fast delivery for just $1.99 on most orders.";
  const LAST_CALL   = process.env.CN_LAST_CALL        || "Last call for delivery is 8:15 PM daily. Orders placed after that time, or from distant locations, may be scheduled for the next day — so get your orders in early!";
  const MED_PTS     = process.env.CN_MED_PATIENTS     || "We also accept verified medical patients ages 18+ with a valid recommendation.";
  const PARKING     = process.env.CN_PARKING          || "Plenty of street parking available right on J Street and 23rd — easy access to the shop!";
  const PAYMENT     = process.env.CN_PAYMENT          || "We accept cash and JanePay for both in-store and delivery orders. And if you need cash, no worries — we’ve got two ATMs right inside the dispensary.";
  const SPECIALS    = process.env.CN_SPECIALS         || "To check out today’s deals, just visit crystalnugs.com — our daily specials will appear automatically. Deals change every single day, so don’t miss out!";
  const RETURNS     = process.env.CN_RETURN_POLICY    || "In accordance with California DCC regulations, Crystal Nugs may exchange most defective products within 24 hours of purchase when returned in their original packaging and accompanied by a valid receipt. Exchanges are limited to products verified as defective and purchased directly from our dispensary. For more details on eligible items and procedures, please visit the FAQ section on our website.";
  const VENDOR_INFO = process.env.CN_VENDOR_INFO      || "Vendors and brands looking to collaborate with Crystal Nugs can email chris@crystalnugs.com with your catalog, absolute best pricing structure, and what sets your brand apart. Our purchasing team reviews all submissions weekly and will reach out directly if your products are a fit for our dispensary lineup.";
  const VENDOR_DEMO = process.env.CN_VENDOR_DEMO      || "If you’d like to schedule an in-store demo or brand activation at Crystal Nugs, please email our demo coordinator at gummiegrannie72@gmail.com with your preferred dates, time slots, and sample information. Our events team will confirm availability and handle compliance details.";
  const WEBSITE     = process.env.CN_WEBSITE          || "https://www.crystalnugs.com";
  const MAP_URL     = process.env.CN_DIRECTIONS_URL   || "https://maps.google.com/?q=2300+J+Street,+Sacramento,+CA+95816";

  // 🕒 Hours
  if (/\bhour|open|close|when\b/.test(q)) {
    const add = LAST_CALL ? ` ${LAST_CALL}` : "";
    return `${HOURS}${add} Anything else I can help with?`;
  }

  // 📍 Address / directions
  if (/\baddress|location|where|directions|how to get\b/.test(q)) {
    const add = MAP_URL ? ` For directions, you can use this link: ${MAP_URL}` : "";
    return `We’re located at ${ADDRESS}.${add}`;
  }

  // 🪪 ID rules / age
  if (/\bid|identification|age|21\b/.test(q)) {
    const med = MED_PTS ? ` ${MED_PTS}` : "";
    return `${ID_RULES}${med}`;
  }

  // 🚗 Delivery areas / fees / minimums / last call
  if (/\bdeliver|delivery|zone|area|radius|how far|minimum|fee|charge\b/.test(q)) {
    const min = DELIV_MIN ? ` ${DELIV_MIN}.` : "";
    const fee = DELIV_FEE ? ` ${DELIV_FEE}` : "";
    const last = LAST_CALL ? ` ${LAST_CALL}` : "";
    return `${DELIVERY}${min}${fee}${last ? " " + last : ""} Share your address to confirm coverage.`;
  }

  // 🅿️ Parking
  if (/\bparking|park\b/.test(q)) {
    return PARKING || "Street parking is available nearby.";
  }

  // 💳 Payments / ATM / JanePay
  if (/\bpay|payment|cash|card|debit|atm|jane ?pay\b/.test(q)) {
    return `${PAYMENT} Anything else I can help with?`;
  }

  // 💥 Specials / deals / promos
  if (/\bdeal|special|discount|offer|promotion|promo|promos\b/.test(q)) {
    return `${SPECIALS} Would you like any help finding something specific?`;
  }

  // 🔁 Returns / exchanges / defective
  if (/\breturn|exchange|refund|defective|replace|swap\b/.test(q)) {
    return RETURNS;
  }

  // 🏢 Vendor / brand inquiries
  if (/\bvendor|brand|wholesale|distributor|carry my product|buyer\b/.test(q)) {
    return VENDOR_INFO;
  }

  // 🎤 Demo scheduling
  if (/\bdemo|activation|in-?store|pop-?up|brand day|sampling|event\b/.test(q)) {
    return VENDOR_DEMO;
  }

  return null; // let OpenAI handle anything else
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
