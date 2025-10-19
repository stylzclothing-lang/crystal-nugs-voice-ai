// server.js — Crystal Nugs Voice AI (Twilio Conversation Relay + OpenAI Realtime, TEXT mode)

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import bodyParser from "body-parser";
import { config } from "dotenv";
import twilio from "twilio";

config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12";

if (!OPENAI_API_KEY) {
  console.warn("[WARN] Missing OPENAI_API_KEY in environment");
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- Voice Webhook ----------
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

// ---------- WebSocket bridge: Twilio CR <-> OpenAI Realtime (TEXT) ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (TEXT mode)");
  let openaiWS;

  try {
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

    openaiWS = await connectOpenAI(OPENAI_REALTIME_MODEL);
    console.log("OpenAI realtime connected");

    // Initialize session
    safeSend(openaiWS, {
      type: "session.update",
      session: {
        instructions:
          "You are the Crystal Nugs Sacramento voice assistant. Be concise, friendly, and accurate. Store hours are 9am-9pm daily. ID rules: valid government ID, must be 21+. Delivery zones: Midtown and greater Sacramento. Avoid medical claims and payments by phone. If the caller asks to speak to a person, say 'No problem — transferring you now' and stop."
      }
    });

    // Twilio → OpenAI
    twilioWS.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.type === "setup") {
