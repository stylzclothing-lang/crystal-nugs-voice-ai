// server.js — Crystal Nugs Voice AI (Amazon Polly Joanna + URL/Email Sanitizer)
// Twilio Conversation Relay (TEXT) + Local Intents + OpenAI fallback

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
const TRANSFER_NUMBER = process.env.TWILIO_VOICE_FALLBACK || "+19165071099";
const USE_SSML = String(process.env.CN_USE_SSML || "false").toLowerCase() === "true";

// ===== Business Facts (env-driven; update in Render → Environment) =====
const HOURS =
  process.env.CN_HOURS ||
  "Our dispensary is open daily from 9:00 AM to 9:00 PM, and we take delivery orders from 8:30 AM to 8:30 PM.";

const ADDRESS = process.env.CN_ADDRESS || "2300 J Street, Sacramento, CA 95816";

const ID_RULES =
  process.env.CN_ID_RULES ||
  "You’ll need a valid government-issued photo ID and be at least 21+.";

const DELIVERY =
  process.env.CN_DELIVERY ||
  "We deliver to Midtown and the greater Sacramento area including Citrus Heights, Roseville, Lincoln, Folsom, Elk Grove, and more. Share your address to confirm delivery.";

const DELIV_MIN =
  process.env.CN_DELIVERY_MINIMUM ||
  "Order minimums depend on where you’re located — for the immediate Sacramento area, it’s just $40.";

const DELIV_FEE =
  process.env.CN_DELIVERY_FEE ||
  "Enjoy fast delivery for just $1.99 on most orders.";

const LAST_CALL =
  process.env.CN_LAST_CALL ||
  "Last call for delivery is 8:15 PM daily. Orders placed after that time, or from distant locations, may be scheduled for the next day.";

const MED_PTS =
  process.env.CN_MED_PATIENTS ||
  "We also accept verified medical patients ages 18+ with a valid recommendation.";

const PARKING =
  process.env.CN_PARKING ||
  "Plenty of street parking available right on J Street and 23rd — easy access to the shop!";

const PAYMENT =
  process.env.CN_PAYMENT ||
  "We accept cash and JanePay for both in-store and delivery orders. If you need cash, we’ve got two ATMs in-store.";

const SPECIALS =
  process.env.CN_SPECIALS ||
  "To check out today’s deals, just visit crystalnugs.com — our daily specials appear automatically. Deals change every day.";

const RETURNS =
  process.env.CN_RETURN_POLICY ||
  "Crystal Nugs may exchange most defective products within 24 hours of purchase when returned in original packaging with a valid receipt, per California DCC regulations.";

const VENDOR_INFO =
  process.env.CN_VENDOR_INFO ||
  "Vendors and brands can email chris at crystal nugs dot com — that's C-H-R-I-S at crystal nugs dot com — with your catalog, best pricing, and what makes your brand stand out. Our purchasing team reviews submissions weekly.";

const VENDOR_DEMO =
  process.env.CN_VENDOR_DEMO ||
  "If you’d like to schedule an in-store demo or brand activation at Crystal Nugs, please email our demo coordinator at caprice at crystal nugs dot com — that's C-A-P-R-I-C-E at crystal nugs dot com — with your preferred dates, time slots, and sample information. Our events team will confirm availability and handle compliance details.";

const WEBSITE = process.env.CN_WEBSITE || "https://www.crystalnugs.com";

const MAP_URL =
  process.env.CN_DIRECTIONS_URL ||
  "Crystal Nugs is at 2300 J Street in Midtown Sacramento — the neon green building on the corner of J and 23rd.";

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- Voice Webhook ----------
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?";

  // Amazon Polly (balanced, clear female): Joanna
  const twiml =
    `<Response>
       <Connect>
         <ConversationRelay
           url="${wsUrl}"
           ttsProvider="Amazon"
           voice="Joanna"
           welcomeGreeting="${escapeXml(greeting)}" />
       </Connect>
     </Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Optional transfer ----------
app.post("/twilio/transfer", (_req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("No problem. Transferring you now.");
  vr.dial(TRANSFER_NUMBER);
  res.type("text/xml").send(vr.toString());
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

// ---------- WebSocket Bridge ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (HTTPS Chat + local intents)");

  twilioWS.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.type === "setup") return;

    if (msg.type === "prompt" && msg.voicePrompt) {
      const userText = msg.voicePrompt.trim().toLowerCase();
      console.log("Caller said:", userText);

      // 1) Local intents (fast path)
      const local = handleLocalIntent(userText);
      if (local) {
        safeSend(twilioWS, { type: "text", token: brandVoice(local), last: true });
        return;
      }

      // 2) Fallbacks
      if (!OPENAI_API_KEY) {
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice("Sorry, I’m having trouble connecting right now."),
          last: true,
        });
        return;
      }

      // 3) OpenAI fallback
      try {
        const answer = await askOpenAI(userText);
        safeSend(twilioWS, { type: "text", token: brandVoice(answer), last: true });
      } catch (e) {
        console.error("OpenAI HTTPS error:", e.message);
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice("Sorry, our assistant is currently busy. Please call back shortly."),
          last: true,
        });
      }
    }
  });

  twilioWS.on("close", () => console.log("Twilio disconnected"));
});

// ---------- Local Intent Handler ----------
function handleLocalIntent(q = "") {
  if (/\bhour|open|close|when\b/.test(q)) return `${HOURS} ${LAST_CALL}`;
  if (/\baddress|location|where|directions|how to get\b/.test(q)) return MAP_URL;
  if (/\bwebsite|site|url|online|menu\b/.test(q)) return "You can visit us online at Crystal Nugs dot com.";
  if (/\bid|identification|age|21\b/.test(q)) return `${ID_RULES} ${MED_PTS}`;
  if (/\bdeliver|delivery|zone|area|minimum|fee|charge\b/.test(q)) return `${DELIVERY} ${DELIV_MIN} ${DELIV_FEE}`;
  if (/\bparking|park\b/.test(q)) return PARKING;
  if (/\bpay|payment|cash|card|debit|atm|jane ?pay\b/.test(q)) return PAYMENT;
  if (/\bdeal|special|discount|offer|promotion|promo\b/.test(q)) return SPECIALS;
  if (/\breturn|exchange|refund|defective|replace|swap\b/.test(q)) return RETURNS;
  if (/\bvendor|brand|wholesale|distributor|buyer\b/.test(q)) return VENDOR_INFO;
  if (/\bdemo|activation|in-?store|pop-?up|event\b/.test(q)) return VENDOR_DEMO;
  return null;
}

// ---------- OpenAI Chat fallback ----------
async function askOpenAI(userText) {
  const systemPrompt = `
You are the Crystal Nugs Sacramento AI voice assistant.
Speak in a warm, concierge tone. Keep sentences short. Use natural pauses.
Never read raw URLs. Say "Crystal Nugs dot com" instead of a link.
If asked for a person, say “No problem, transferring you now.”
Store hours: ${HOURS}
Address: ${ADDRESS}
Website: ${toSpokenText(WEBSITE)}
Delivery: ${DELIVERY}
ID rules: ${ID_RULES}
Payment: ${PAYMENT}
Returns: ${RETURNS}
  `;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    }),
  });

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "Sorry, I didn’t catch that.";
}

// ---------- Utils ----------
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error("WS send error:", e.message);
  }
}

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert crystalnugs.com and house emails to friendly spoken phrases. */
function toSpokenText(text = "") {
  if (!text) return "";
  let out = String(text);

  // Normalize our site in all common forms
  out = out.replace(/https?:\/\/(www\.)?crystalnugs\.com\/?/gi, "Crystal Nugs dot com");
  out = out.replace(/\bwww\.crystalnugs\.com\b/gi, "Crystal Nugs dot com");
  out = out.replace(/\bcrystalnugs\.com\b/gi, "Crystal Nugs dot com");

  // Convert any *@crystalnugs.com email to "name at crystal nugs dot com"
  out = out.replace(
    /\b([a-z0-9._%+-]+)@crystalnugs\.com\b/gi,
    (_m, user) => `${user} at crystal nugs dot com`
  );

  // Generic: remove protocol for any other links that might slip through
  out = out.replace(/https?:\/\//gi, "");

  return out;
}

/**
 * Brand voice preset:
 * - Always sanitize via toSpokenText()
 * - Plain text mode: concise sentences and em dashes for micro-pauses.
 * - SSML mode (CN_USE_SSML=true): adds <break> and stable prosody (Polly supports SSML).
 */
function brandVoice(raw = "") {
  const cleaned = toSpokenText(raw).trim();

  if (!USE_SSML) {
    // Plain text shaping to sound natural on most TTS engines.
    return cleaned
      .replace(/\s+/g, " ")
      .replace(/\s-\s/g, " — ")
      .replace(/:\s+/g, ": ")
      .replace(/,{2,}/g, ",")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " ");
  }

  // SSML mode: gentle pacing between sentences.
  const parts = cleaned
    .split(/(?<=[\.\?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ssmlBody = parts.map((s) => escapeSSML(s)).join('<break time="200ms"/>');

  return `<speak><prosody rate="medium" pitch="+0%">` + ssmlBody + `</prosody></speak>`;
}

function escapeSSML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
