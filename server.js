// server.js (Twilio Conversation Relay TEXT bridge with OpenAI Realtime)

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
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
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12";

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set.");
}

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Voice webhook: return TwiML instructing Twilio to connect CR to wss://<host>/relay
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, ID rules, or order lookups. What can I do for you?";
  const twiml =
    "<Response>" +
      "<Connect>" +
        `<ConversationRelay url="${wsUrl}" welcomeGreeting="${escapeXml(greeting)}"/>` +
      "</Connect>" +
    "</Response>";
  res.type("text/xml").send(twiml);
});

// Optional: live transfer fallback
app.post("/twilio/transfer", (_req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say("Transferring you to a live budtender now.");
  twiml.dial(process.env.TWILIO_VOICE_FALLBACK || "+19165071099");
  res.type("text/xml").send(twiml.toString());
});

// Optional: call status logger (configure in Twilio "Call status changes")
app.post("/twilio/status", (req, res) => {
  console.log("Call status:", req.body?.CallStatus, req.body?.CallSid);
  res.sendStatus(200);
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

// WebSocket bridge: Twilio Conversation Relay <-> OpenAI Realtime (TEXT mode)
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (TEXT mode)");
  let openaiWS;

  try {
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

    // Connect to OpenAI Realtime using the required subprotocol
    openaiWS = await connectOpenAI(OPENAI_REALTIME_MODEL);
    console.log("OpenAI realtime connected");

    // Prime the assistant
    safeSend(openaiWS, {
      type: "response.create",
      response: {
        instructions:
          "You are the Crystal Nugs Sacramento voice assistant. Be concise, friendly, and accurate. Store hours are 9am-9pm daily. ID rules: valid government ID, must be 21+. Delivery zones: Midtown and greater Sacramento. Avoid medical claims and payments by phone. If the caller asks to speak to a person, say 'No problem — transferring you now' and stop talking."
      }
    });

    // Twilio -> OpenAI
    twilioWS.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.type === "setup") {
        console.log("CR setup:", msg.sessionId, msg.callSid || "");
        return;
      }

      if (msg.type === "prompt" && msg.voicePrompt) {
        const userText = (msg.voicePrompt || "").trim();
        console.log("Caller said:", userText);

        safeSend(openaiWS, {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: userText }]
          }
        });
        safeSend(openaiWS, { type: "response.create" });
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
      try { openaiWS?.close(); } catch {}
      console.log("Twilio disconnected");
    });

    // OpenAI -> Twilio (stream text tokens Twilio will TTS)
    openaiWS.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (m.type === "response.output_text.delta" && m.delta) {
        console.log("MODEL TOKEN:", m.delta);
        safeSend(twilioWS, { type: "text", token: m.delta, last: false });
      }

      if (m.type === "response.completed") {
        console.log("MODEL TURN COMPLETE");
        safeSend(twilioWS, { type: "text", token: "", last: true });
      }

      if (m.type === "response.error") {
        console.error("OpenAI response.error:", m.error || m);
      }
    });

    openaiWS.on("close", () => console.log("OpenAI session ended"));
    openaiWS.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
  } catch (err) {
    console.error("Relay init error:", err?.message || err);
    try { openaiWS?.close(); } catch {}
    try { twilioWS?.close(); } catch {}
  }
});

// Helpers

function connectOpenAI(model) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    // Important: specify subprotocol 'openai-realtime-v1'
    const ws = new WebSocket(url, "openai-realtime-v1", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", (e) => reject(e));
  });
}

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
