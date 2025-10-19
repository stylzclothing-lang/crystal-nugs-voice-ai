// server.js — Crystal Nugs Voice AI (Twilio Conversation Relay + OpenAI Chat via HTTPS)

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini"; // fast, good quality

if (!OPENAI_API_KEY) {
  console.warn("[WARN] Missing OPENAI_API_KEY in environment");
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- Voice Webhook (TwiML returns ConversationRelay) ----------
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, address, frequently asked questions or delivery order lookups. What can I do for you today?";
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
  twiml.say("Transferring you to a live budtender now.");
  twiml.dial(process.env.TWILIO_VOICE_FALLBACK || "+19165071099");
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

// ---------- WebSocket bridge: Twilio CR <-> (HTTPS) OpenAI Chat ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (HTTPS Chat mode)");

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

      try {
        const answer = await askOpenAI(userText);
        // Send a single text message back; CR will TTS it.
        safeSend(twilioWS, { type: "text", token: answer, last: true });
        console.log("Replied with", Math.min(answer.length, 80), "chars");
      } catch (e) {
        console.error("OpenAI HTTPS error:", e?.message || e);
        safeSend(twilioWS, {
          type: "text",
          token: "Sorry, I’m having trouble right now.",
          last: true
        });
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

// ---------- OpenAI HTTPS helper ----------
const SYSTEM_PROMPT =
  "You are the Crystal Nugs Sacramento voice assistant. Be concise, friendly, and accurate. Store hours are 9am-9pm daily. ID rules: valid government ID, must be 21+. Delivery zones: Midtown and greater Sacramento. Avoid medical claims and payments by phone. If the caller asks to speak to a person, say 'No problem — transferring you now' and stop.";

async function askOpenAI(userText) {
  // Use Chat Completions–style schema for compatibility
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
