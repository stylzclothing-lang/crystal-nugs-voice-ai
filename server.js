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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12";

// ---- Health Check ----
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Twilio Voice Webhook ----
app.post("/twilio/voice", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting = "Hey! Thanks for calling Crystal Nugs Sacramento. How can I help you today?";

  const connect = twiml.connect();
  connect.conversationRelay({ url: wsUrl, welcomeGreeting: greeting });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ---- Fallback route ----
app.post("/twilio/transfer", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.dial(process.env.TWILIO_VOICE_FALLBACK || "+19165071099");
  res.type("text/xml");
  res.send(twiml.toString());
});

// ---- WebSocket Relay ----
const server = app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);

const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", async (ws) => {
  console.log("🔗 Twilio connected to Conversation Relay");

  // Create a Realtime session with OpenAI
  const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_REALTIME_MODEL,
      voice: "verse",
    }),
  });

  const data = await response.json();
  const openAiSocket = new WebSocket(data.client_secret.value, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });

  // Relay audio/messages between Twilio and OpenAI
  openAiSocket.on("message", (msg) => ws.send(msg));
  ws.on("message", (msg) => openAiSocket.send(msg));

  ws.on("close", () => {
    console.log("❌ Twilio disconnected");
    openAiSocket.close();
  });

  openAiSocket.on("close", () => console.log("🧠 OpenAI session ended"));
});
