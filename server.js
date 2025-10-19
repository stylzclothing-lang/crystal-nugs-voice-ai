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
  console.warn(
    "[WARN] OPENAI_API_KEY is not set. The relay will fail when a call connects."
  );
}

// ---- Health Check ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Twilio Voice Webhook (returns raw TwiML) ----
app.post("/twilio/voice", async (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Hey! Thanks for calling Crystal Nugs Sacramento. I can help with hours, ID rules, delivery zones, and order lookups. How can I help you today?";
  const twiml = `
    <Response>
      <Connect>
        <ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}"/>
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// ---- Fallback route (live transfer) ----
app.post("/twilio/transfer", (_req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say("Transferring you to a live budtender now.");
  twiml.dial(process.env.TWILIO_VOICE_FALLBACK || "+19165071099");
  res.type("text/xml").send(twiml.toString());
});

// ---- Status Logger (optional) ----
app.post("/twilio/status", (req, res) => {
  console.log("📞 Call status:", req.body?.CallStatus, req.body?.CallSid);
  res.sendStatus(200);
});

// =====================================================================
// WebSocket Relay: Twilio Conversation Relay  ⇄  OpenAI Realtime
// =====================================================================

const server = app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);

// WS server that Twilio connects to
const wss = new WebSocketServer({ server, path: "/relay" });

// Create OpenAI Realtime WS connection
function connectOpenAI(model) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      model
    )}`;
    const openai = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    openai.on("open", () => resolve(openai));
    openai.on("error", (e) => reject(e));
  });
}

// Small helper to commit after brief silence
const COMMIT_SILENCE_MS = 600;

wss.on("connection", async (twilioWS) => {
  console.log("🔗 Twilio connected to Conversation Relay");
  let openaiWS;
  let commitTimer = null;

  const scheduleCommit = () => {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      // tell OpenAI to process what we’ve buffered and speak
      safeSend(openaiWS, { type: "input_audio_buffer.commit" });
      safeSend(openaiWS, { type: "response.create" });
    }, COMMIT_SILENCE_MS);
  };

  try {
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

    // 1) Connect to OpenAI realtime
    openaiWS = await connectOpenAI(OPENAI_REALTIME_MODEL);

    // 2) Prime the assistant (instructions / guardrails)
    safeSend(openaiWS, {
      type: "response.create",
      response: {
        instructions:
          "You are the Crystal Nugs Sacramento voice assistant. Be concise, friendly, and professional. Hours are 9am–9pm daily. ID rules: valid government ID, 21+. Delivery zones: Midtown and greater Sacramento. If the caller asks for a person, say 'No problem — transferring you now' and stop speaking. Never discuss medical claims or take payments over the phone.",
      },
    });

    // ------------------- Twilio -> OpenAI -------------------
    twilioWS.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Twilio CR events: start, media, transcript, mark, stop
      if (msg.event === "media" && msg.media?.payload) {
        // caller audio (base64 PCM) → OpenAI input buffer
        safeSend(openaiWS, {
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        });
        scheduleCommit();
      } else if (msg.event === "transcript" && msg.transcript?.text) {
        // forward transcript as user text for faster understanding
        safeSend(openaiWS, {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: msg.transcript.text }],
          },
        });
        safeSend(openaiWS, { type: "response.create" });

        // (Optional) detect escalation intent
        if (
          /human|person|representative|agent|associate|budtender|talk to someone|transfer/i.test(
            msg.transcript.text
          )
        ) {
          // you could end relay and re-invite with /twilio/transfer, or send an app signal
          console.log("🔁 Transfer requested by caller.");
        }
      } else if (msg.event === "stop") {
        try {
          openaiWS?.close();
        } catch {}
        try {
          twilioWS?.close();
        } catch {}
      }
    });

    twilioWS.on("close", () => {
      try {
        openaiWS?.close();
      } catch {}
      console.log("❌ Twilio disconnected");
    });

    // ------------------- OpenAI -> Twilio -------------------
    openaiWS.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // OpenAI realtime TTS stream: output_audio.delta (base64)
      if (m.type === "output_audio.delta" && m.audio) {
        safeSend(twilioWS, {
          event: "media",
          media: { payload: m.audio },
        });
      }

      // Segment completed (optional mark)
      if (m.type === "output_audio.done") {
        safeSend(twilioWS, { event: "mark", name: "segment_done" });
      }
    });

    openaiWS.on("close", () => console.log("🧠 OpenAI session ended"));
    openaiWS.on("error", (e) =>
      console.error("OpenAI WS error:", e?.message || e)
    );
  } catch (err) {
    console.error("Relay init error:", err?.message || err);
    try {
      openaiWS?.close();
    } catch {}
    try {
      twilioWS?.close();
    } catch {}
  }
});

// Safe WS sender
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error("WS send error:", e?.message || e);
  }
}
