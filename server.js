// server.js — Crystal Nugs Voice AI (Google en-US-Wavenet-F) + Jane Product Lookup + Live Transfer
// ConversationRelay + Product search (iHeartJane) + Local Intents (ZIP-aware mins/fees/ETA) + Venue answers + OpenAI fallback

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const USE_SSML = String(process.env.CN_USE_SSML || "false").toLowerCase() === "true";

const TRANSFER_NUMBER =
  process.env.TWILIO_TRANSFER_NUMBER ||
  process.env.TWILIO_VOICE_FALLBACK ||
  "+19167019777"; // Crystal Nugs store line (E.164)

const JANE_LOOKUPS_ENABLED =
  String(process.env.JANE_LOOKUPS_ENABLED || "true").toLowerCase() === "true";

// ---------- URL + phone helpers ----------
function normalizeBaseUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/^https?:\/\/https?:\/\//i, "https://");
  s = s.replace(/\/+$/g, "");
  return s;
}

const BASE_URL = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""
);

function absUrl(path = "/") {
  const base = BASE_URL;
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  return url.replace(/^https?:\/\/https?:\/\//i, "https://");
}

function speakPhone(e164 = "+19167019777") {
  const digits = String(e164).replace(/[^\d]/g, "");
  const parts =
    digits.startsWith("1") && digits.length === 11
      ? [digits.slice(1, 4), digits.slice(4, 7), digits.slice(7)]
      : digits.length === 10
      ? [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
      : [digits];
  return parts
    .map((seg, i) => seg.split("").join("-") + (i < parts.length - 1 ? "," : ""))
    .join(" ")
    .trim();
}

// ---------- Live transfer (Calls API) ----------
async function transferLiveCall(callSid) {
  if (!callSid) throw new Error("Missing CallSid for transfer");
  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!ACCOUNT_SID || !AUTH_TOKEN) throw new Error("Missing Twilio creds (Account SID/Auth Token)");

  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  const TRANSFER_URL = absUrl("/twilio/transfer");
  console.log("Attempting live transfer to:", TRANSFER_URL, "CallSid:", callSid);

  return client.calls(callSid).update({ method: "POST", url: TRANSFER_URL });
}

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

// Venues policy (allowed when asked)
const DELIVERY_PLACES =
  process.env.CN_DELIVERY_PLACES ||
  "Yes — we deliver to hotels, motels, restaurants, bars, and truck stops within our service area. Please have a valid government ID (21+) and the name on the order present at handoff. For hotels, include the registered guest and room number; we can meet at the lobby or front desk if required. For restaurants, bars, or truck stops, we’ll meet at the main entrance, host stand, or a designated safe area. Payment: cash or JanePay.";

// ===== Delivery Minimum + Fee + ETA Window table =====
const DEFAULT_DELIVERY_TABLE = [
  { zip:"95811", minimum:40, fee:1.99, window:"30–60 minutes" },
  { zip:"95814", minimum:40, fee:1.99, window:"30–60 minutes" },
  { zip:"95815", minimum:40, fee:1.99, window:"30–60 minutes" },
  { zip:"95816", minimum:40, fee:1.99, window:"30–60 minutes" },
  { zip:"95817", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95818", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95819", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95820", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95821", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95822", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95823", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95824", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95825", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95826", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95827", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95828", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95829", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95605", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95691", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95798", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95799", minimum:40, fee:1.99, window:"45–75 minutes" },
  { zip:"95673", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95626", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95652", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95838", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95628", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95670", minimum:60, fee:1.99, window:"75–150 minutes" },
  { zip:"95655", minimum:60, fee:1.99, window:"75–150 minutes" },
  { zip:"95683", minimum:125, fee:1.99, window:"120–240 minutes" },
  { zip:"95741", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95742", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95610", minimum:60, fee:1.99, window:"75–150 minutes" },
  { zip:"95611", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95621", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95841", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95608", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95609", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95660", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95842", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95830", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95831", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95832", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95833", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95834", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95835", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95836", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95837", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95843", minimum:50, fee:1.99, window:"60–120 minutes" },
  { zip:"95864", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95695", minimum:65, fee:1.99, window:"90–180 minutes" },
  { zip:"95776", minimum:70, fee:1.99, window:"90–180 minutes" },
  { zip:"95616", minimum:65, fee:1.99, window:"90–180 minutes" },
  { zip:"95617", minimum:65, fee:1.99, window:"90–180 minutes" },
  { zip:"95618", minimum:65, fee:1.99, window:"90–180 minutes" },
  { zip:"95662", minimum:70, fee:1.99, window:"90–180 minutes" },
  { zip:"95668", minimum:60, fee:1.99, window:"75–150 minutes" },
  { zip:"95630", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95671", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95763", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95762", minimum:100, fee:1.99, window:"90–180 minutes" },
  { zip:"95677", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95678", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95747", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95765", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95650", minimum:100, fee:1.99, window:"90–180 minutes" },
  { zip:"95661", minimum:70, fee:1.99, window:"90–180 minutes" },
  { zip:"95746", minimum:60, fee:1.99, window:"75–150 minutes" },
  { zip:"95648", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95624", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95757", minimum:80, fee:1.99, window:"90–180 minutes" },
  { zip:"95758", minimum:70, fee:1.99, window:"90–180 minutes" },
  { zip:"95759", minimum:70, fee:1.99, window:"90–180 minutes" },
  { zip:"95632", minimum:80, fee:3.49, window:"90–180 minutes" },
  { zip:"95612", minimum:40, fee:1.99, window:"45–90 minutes" },
  { zip:"95693", minimum:125, fee:3.49, window:"120–240 minutes" },
  { zip:"95639", minimum:80, fee:3.49, window:"120–240 minutes" },
  { zip:"95672", minimum:80, fee:1.99, window:"90–180 minutes" }
];

let DELIVERY_TABLE = DEFAULT_DELIVERY_TABLE;
try {
  const override = process.env.CN_DELIVERY_TABLE ? JSON.parse(process.env.CN_DELIVERY_TABLE) : null;
  if (Array.isArray(override) && override.length) DELIVERY_TABLE = override;
} catch { /* keep default */ }

DELIVERY_TABLE = DELIVERY_TABLE.map((r) => ({
  ...r,
  window: r.window || computeEtaWindow(r.minimum, r.zip),
}));

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Jane env debug (no secrets)
app.get("/jane/debug", (_req, res) => {
  const base = canonicalJaneBase(process.env.JANE_API_BASE || "https://api.iheartjane.com");
  const storeId = process.env.JANE_STORE_ID ? String(process.env.JANE_STORE_ID) : null;
  const tokenSet = !!process.env.JANE_API_TOKEN;
  const tokenLen = process.env.JANE_API_TOKEN ? process.env.JANE_API_TOKEN.length : 0;
  res.json({
    base,
    storeIdPresent: !!storeId,
    tokenPresent: tokenSet,
    tokenLength: tokenLen,
    lookupsEnabled: String(process.env.JANE_LOOKUPS_ENABLED || "true"),
  });
});

// Public IP helper (for Jane allowlisting)
app.get("/whoami", async (_req, res) => {
  try {
    const r = await fetch("https://ifconfig.me/ip");
    const ip = await r.text();
    res.json({ ip: ip.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Jane test endpoint
app.get("/jane/test", async (_req, res) => {
  try {
    const items = await janeMenuSearch("maven pre-roll", 3);
    res.json({ ok: true, sample: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Voice Webhook ----------
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.get("host")}/relay`;
  const greeting =
    "Welcome to Crystal Nugs Sacramento. I can help with delivery areas, store hours, our address, frequently asked questions, or delivery order lookups. What can I do for you today?";

  const twiml =
    `<Response>
       <Connect>
         <ConversationRelay
           url="${wsUrl}"
           ttsProvider="Google"
           voice="en-US-Wavenet-F"
           welcomeGreeting="${escapeXml(greeting)}" />
       </Connect>
     </Response>`;

  console.log("Serving /twilio/voice TwiML:\n", twiml);
  res.type("text/xml").send(twiml);
});

// ---------- Transfer endpoint (TwiML) ----------
app.post("/twilio/transfer", (_req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("No problem. Transferring you now.");
  vr.dial(TRANSFER_NUMBER);
  res.type("text/xml").send(vr.toString());
});

// ---------- Call status logs ----------
app.post("/twilio/status", (req, res) => {
  console.log("Call status:", req.body?.CallStatus, req.body?.CallSid);
  res.sendStatus(200);
});

// ---------- Start HTTP ----------
const server = app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

server.on("upgrade", (req) => {
  console.log("HTTP upgrade (WS) ->", req.url);
});

// ---------- WebSocket Bridge ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("error", (err) => {
  console.error("WSS server error:", err?.message || err);
});

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected to Conversation Relay (HTTPS Chat + local intents)");

  let currentCallSid = null;

  twilioWS.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.type === "setup") {
      currentCallSid =
        msg.callSid || msg.start?.callSid || msg.start?.twilio?.callSid || null;
      console.log("Setup received. CallSid:", currentCallSid);
      return;
    }

    if (msg.type === "prompt" && msg.voicePrompt) {
      const userText = msg.voicePrompt.trim().toLowerCase();
      console.log("Caller said:", userText);

      // ---------- 0) Product lookup via Jane (before local intents) ----------
      const productIntent = detectProductQuery(userText);

      if (productIntent && JANE_LOOKUPS_ENABLED) {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 5000);
        try {
          const results = await janeMenuSearch(productIntent, 12, ac.signal);
          clearTimeout(to);

          const list = formatJaneItems(results, 3);
          const sum = summarizeJaneResults(results);

          let headline;
          if (sum.count > 0) {
            const minS = money(sum.min);
            const maxS = money(sum.max);
            if (minS && maxS && minS !== maxS) {
              headline = `I’m seeing about ${sum.count} items right now. Current price range is ${minS} to ${maxS}.`;
            } else if (minS && (!maxS || minS === maxS)) {
              headline = `I’m seeing about ${sum.count} items right now. Current price is around ${minS}.`;
            } else {
              headline = `I’m seeing about ${sum.count} items right now. Pricing varies by strain.`;
            }
          } else {
            headline = `I didn’t see that available right now.`;
          }

          const msgOut =
            sum.count > 0
              ? list
                ? `Yes — we carry ${productIntent}. ${headline} Top picks: ${list}. You can order at Crystal Nugs dot com.`
                : `Yes — we carry ${productIntent}. ${headline} You can check varieties and prices at Crystal Nugs dot com.`
              : `I didn’t see ${productIntent} available right now. Please check Crystal Nugs dot com for live inventory.`;

          safeSend(twilioWS, {
            type: "text",
            token: brandVoice(msgOut),
            last: true,
          });
        } catch (e) {
          clearTimeout(to);
          console.error("Jane lookup error:", e.message);
          // Nice fallback: still answer yes generically if brand matched
          const softYes = /maven/i.test(productIntent)
            ? "Yes — we carry Maven. You can check current varieties and prices at Crystal Nugs dot com."
            : "I couldn’t reach our live menu just now. Please check Crystal Nugs dot com for current stock.";
          safeSend(twilioWS, {
            type: "text",
            token: brandVoice(softYes),
            last: true,
          });
        }
        return;
      } else if (productIntent && !JANE_LOOKUPS_ENABLED) {
        const soft = /maven/i.test(productIntent)
          ? "Yes — we carry Maven. Check Crystal Nugs dot com for varieties and prices."
          : "We carry that brand. Check Crystal Nugs dot com for live inventory.";
        safeSend(twilioWS, { type: "text", token: brandVoice(soft), last: true });
        return;
      }

      // ---------- 1) Local intents (fast path) ----------
      const local = handleLocalIntent(userText);

      // Immediate transfer branch
      if (local === "__TRANSFER_NOW__") {
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice("No problem. Transferring you now."),
          last: true,
        });
        try {
          await transferLiveCall(currentCallSid);
          console.log("Live transfer initiated for CallSid:", currentCallSid);
        } catch (e) {
          console.error("Transfer error:", e.message);
          safeSend(twilioWS, {
            type: "text",
            token: brandVoice(
              `I couldn’t transfer the call just now. Here’s our direct line: ${speakPhone(
                TRANSFER_NUMBER
              )}.`
            ),
            last: true,
          });
        }
        return;
      }

      if (local) {
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice(local),
          last: true,
        });
        return;
      }

      // ---------- 2) OpenAI fallback ----------
      if (!OPENAI_API_KEY) {
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice("Sorry, I’m having trouble connecting right now."),
          last: true,
        });
        return;
      }

      try {
        const answer = await askOpenAI(userText);
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice(answer),
          last: true,
        });
      } catch (e) {
        console.error("OpenAI HTTPS error:", e.message);
        safeSend(twilioWS, {
          type: "text",
          token: brandVoice(
            "Sorry, our assistant is currently busy. Please call back shortly."
          ),
          last: true,
        });
      }
    }
  });

  twilioWS.on("error", (err) =>
    console.error("Twilio WS error:", err?.message || err)
  );
  twilioWS.on("close", (code, reason) =>
    console.log("Twilio WS closed:", code, reason?.toString())
  );
});

// ---------- Local Intent Handler ----------
function handleLocalIntent(q = "") {
  const maybeZip = extractZip(q);

  // Ask-for-human
  const wantsHuman = /\b(representative|agent|human|person|operator|manager|associate|someone|live\s*agent)\b/.test(
    q
  );
  if (wantsHuman) return "__TRANSFER_NOW__";

  // Delivery question types
  const asksMin = /\b(min|minimum|order minimum|what.*minimum)\b/.test(q);
  const asksFee = /\b(fee|delivery fee|charge|cost)\b/.test(q);
  const asksDelivery = /\b(deliver|delivery|zone|area|order|eta|time|how long|arrive)\b/.test(
    q
  );

  const asksDeliverTo =
    /\b(can|do|will|y['’]?all|you)\s*(?:.*\s)?(deliver|drop\s?off|bring|meet)\s*(?:to|at)\b/.test(
      q
    ) ||
    /\bdeliver\s*(?:to|at)\b/.test(q) ||
    /\bdo you deliver\b/.test(q);

  const mentionsHotel = /\b(hotel|motel|inn|suite|resort|lodg(e|ing)|air\s?bnb|airbnb)\b/.test(
    q
  );
  const mentionsVenue = /\b(restaurant|bar|club|truck\s?stop|truckstop|gas\s?station|parking\s?lot|diner|cafe|pub)\b/.test(
    q
  );

  // Venue-specific answer when explicitly asked if we deliver *to* them
  if (asksDeliverTo && (mentionsHotel || mentionsVenue)) {
    const z = maybeZip ? speakZip(maybeZip) : null;
    const placeLabel = venueLabel({ mentionsHotel, mentionsVenue });

    if (z) {
      const rec = deliveryByZip(maybeZip);
      if (rec) {
        const min = formatMoney(rec.minimum);
        const fee = formatMoney(rec.fee);
        const win = rec.window || computeEtaWindow(rec.minimum, maybeZip);
        return `Yes — we deliver to ${placeLabel} in ZIP ${z}. ETA ${win}. Minimum ${min}. Fee ${fee}. ${LAST_CALL}`;
      }
      return `Yes — we deliver to ${placeLabel} in that area. For ZIP ${z}, I don’t have a record on file. Share a nearby ZIP and I’ll confirm ETA, minimum, and fee.`;
    }

    return `${DELIVERY_PLACES} What’s your 5-digit ZIP so I can confirm ETA, minimum, and fee? For example: 9-5-8-1-6.`;
  }

  // ZIP-specific minimum/fee/ETA
  if ((asksMin || asksFee || asksDelivery) && maybeZip) {
    const rec = deliveryByZip(maybeZip);
    const z = speakZip(maybeZip);
    if (rec) {
      const min = formatMoney(rec.minimum);
      const fee = formatMoney(rec.fee);
      const win = rec.window || computeEtaWindow(rec.minimum, maybeZip);
      return `For ZIP ${z}: estimated delivery ${win}. Delivery minimum ${min}. Delivery fee ${fee}. ${LAST_CALL}`;
    }
    return `For ZIP ${z}: I don’t have a set delivery policy. Share a nearby ZIP and I’ll confirm your window, minimum, and fee.`;
  }

  // Ask for ZIP first if they want delivery details but didn’t give one
  if (asksMin || asksFee || asksDelivery) {
    return `What’s your 5-digit ZIP so I can confirm your delivery window, minimum, and fee? For example: 9-5-8-1-6.`;
  }

  // Generic intents
  if (/\bhour|open|close|when\b/.test(q)) return `${HOURS} ${LAST_CALL}`;
  if (/\baddress|location|where|directions|how to get\b/.test(q)) return MAP_URL;
  if (/\bwebsite|site|url|online|menu\b/.test(q))
    return "You can visit us online at Crystal Nugs dot com.";
  if (/\bid|identification|age|21\b/.test(q)) return `${ID_RULES} ${MED_PTS}`;
  if (/\bdeliver|delivery|zone|area|minimum|fee|charge\b/.test(q))
    return `${DELIVERY} ${DELIV_MIN} ${DELIV_FEE}`;
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

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `OpenAI ${resp.status} ${resp.statusText}: ${errText.slice(0, 500)}`
    );
  }

  const data = await resp.json().catch(() => null);
  const answer = data?.choices?.[0]?.message?.content?.trim();
  return answer || "Sorry, I didn’t catch that.";
}

// ---------- Jane helpers ----------

// Canonicalize base to api.iheartjane.com
function canonicalJaneBase(input) {
  const def = "https://api.iheartjane.com";
  let u = String(input || "").trim().toLowerCase();
  if (!u) return def;
  if (u.includes("iheartjane.com") && !u.includes("api.iheartjane.com")) return def;
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
}

async function janeMenuSearch(q, limit = 6, signal) {
  const base = canonicalJaneBase(
    process.env.JANE_API_BASE || "https://api.iheartjane.com"
  );
  const storeId = process.env.JANE_STORE_ID;
  const token = process.env.JANE_API_TOKEN;
  if (!token || !storeId) throw new Error("Missing Jane API env vars");

  const url = new URL(`/v1/stores/${storeId}/menu/items`, base);
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("availability", "available");

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "CrystalNugs-VoiceBot/1.0",
    },
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 403 || /cloudflare/i.test(text)) {
      throw new Error(
        "Jane API blocked (403). Check JANE_API_BASE and token; may need IP allowlist."
      );
    }
    throw new Error(`Jane ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  return Array.isArray(data) ? data : data?.items || [];
}

// Ignore $0 and quantity 0
function centsToMoney(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = (n / 100).toFixed(2);
  return s.endsWith(".00") ? `$${parseInt(s, 10)}` : `$${s}`;
}

// Only keep items that have >0 price and >0 quantity (item or variant)
function validJaneItems(items = []) {
  return items.filter((it) => {
    const price = it?.price?.price || 0;
    const qty = it?.quantity_available ?? it?.quantity ?? 0;
    if (price > 0 && qty > 0) return true;

    const vars = Array.isArray(it?.variants) ? it.variants : [];
    return vars.some(
      (v) =>
        Number(v?.price?.price) > 0 &&
        Number(v?.quantity_available ?? v?.quantity ?? 0) > 0
    );
  });
}

function deriveItemPrice(item) {
  const directQty = item?.quantity_available ?? item?.quantity ?? 0;
  const direct = centsToMoney(item?.price?.price);
  if (direct && directQty > 0) return direct;

  const vars = Array.isArray(item?.variants) ? item.variants : [];
  for (const v of vars) {
    const qty = v?.quantity_available ?? v?.quantity ?? 0;
    if (qty > 0) {
      const p = centsToMoney(v?.price?.price);
      if (p) return p;
    }
  }
  return null;
}

function formatJaneItems(items = [], max = 3) {
  const valid = validJaneItems(items);
  const priced = [];
  for (const it of valid) {
    const price = deriveItemPrice(it);
    if (!price) continue;
    const brand = it?.brand?.name ? `${it.brand.name} ` : "";
    const name = it?.name || "product";
    priced.push(`${brand}${name} at ${price}`);
    if (priced.length >= max) break;
  }
  return priced.length ? priced.join(", ") : null;
}

function summarizeJaneResults(items = []) {
  const valid = validJaneItems(items);
  const nums = [];
  for (const it of valid) {
    const p = Number((it?.price?.price || 0) / 100);
    if (p > 0) nums.push(p);

    const vars = Array.isArray(it?.variants) ? it.variants : [];
    for (const v of vars) {
      const qty = v?.quantity_available ?? v?.quantity ?? 0;
      const vp = Number((v?.price?.price || 0) / 100);
      if (vp > 0 && qty > 0) nums.push(vp);
    }
  }
  nums.sort((a, b) => a - b);
  if (!nums.length) return { count: valid.length, min: null, max: null };
  return { count: valid.length, min: nums[0], max: nums[nums.length - 1] };
}

function money(num) {
  if (!Number.isFinite(num) || num <= 0) return null;
  const s = num.toFixed(2);
  return s.endsWith(".00") ? `$${parseInt(s, 10)}` : `$${s}`;
}

// Smarter brand detector with misspellings
function detectProductQuery(text = "") {
  const t = text.toLowerCase();
  const askedCarry = /\b(carry|have|stock|sell|do you (have|carry))\b/.test(t);
  const wantsPreroll = /(pre[\s-]?rolls?|joints?|infused pre[\s-]?rolls?)/i.test(t);

  const normalized = t
    .replace(/\bsteezy\b/g, "stiiizy")
    .replace(/\bstizzy\b/g, "stiiizy");

  const brands = [];
  if (/\bmaven(\s+genetics)?\b/i.test(normalized)) brands.push("Maven");
  if (/\bstii?izy\b/i.test(normalized)) brands.push("STIIIZY");
  if (/\braw\s+garden\b/i.test(normalized)) brands.push("Raw Garden");

  if (brands.length && (askedCarry || wantsPreroll)) {
    if (/\bflower|eighth|7g|3\.5g\b/.test(normalized)) return `${brands[0]} flower`;
    if (/\bvape|pod|cart|cartridge\b/.test(normalized)) return `${brands[0]} vape`;
    return `${brands[0]} pre-rolls`;
  }

  if ((askedCarry || wantsPreroll) && /\b(gelato|zkittlez|blueberry|infused)\b/i.test(normalized)) {
    const term = normalized.match(/\b(gelato|zkittlez|blueberry|infused)\b/i)?.[0];
    return `${term} pre-rolls`;
  }
  return null;
}

// ---------- Utils ----------
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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

function speakZip(zip = "") {
  const z = String(zip).replace(/[^\d]/g, "").slice(0, 5);
  return z.split("").join("-");
}

function extractZip(text = "") {
  const m = String(text).match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

function deliveryByZip(zip) {
  return DELIVERY_TABLE.find((r) => r.zip === zip) || null;
}

function formatMoney(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  const s = num.toFixed(2);
  return s.endsWith(".00") ? `$${parseInt(s, 10)}` : `$${s}`;
}

function computeEtaWindow(minimum) {
  const m = Number(minimum) || 0;
  if (m <= 40) return "30–60 minutes";
  if (m <= 50) return "45–90 minutes";
  if (m <= 70) return "60–120 minutes";
  if (m <= 90) return "75–150 minutes";
  if (m <= 110) return "90–180 minutes";
  return "120–240 minutes";
}

function toSpokenText(text = "") {
  if (!text) return "";
  let out = String(text);
  out = out.replace(/https?:\/\/(www\.)?crystalnugs\.com\/?/gi, "Crystal Nugs dot com");
  out = out.replace(/\bwww\.crystalnugs\.com\b/gi, "Crystal Nugs dot com");
  out = out.replace(/\bcrystalnugs\.com\b/gi, "Crystal Nugs dot com");
  out = out.replace(
    /\b([a-z0-9._%+-]+)@crystalnugs\.com\b/gi,
    (_m, user) => `${user} at crystal nugs dot com`
  );
  out = out.replace(/https?:\/\//gi, "");
  return out;
}

function venueLabel({ mentionsHotel, mentionsVenue }) {
  if (mentionsHotel && mentionsVenue)
    return "hotels, motels, restaurants, bars, and truck stops";
  if (mentionsHotel) return "hotels and motels";
  return "restaurants, bars, and truck stops";
}

// Brand voice: plain or SSML
function brandVoice(raw = "") {
  const cleaned = toSpokenText(raw).trim();

  if (!USE_SSML) {
    return cleaned
      .replace(/\s+/g, " ")
      .replace(/\s-\s/g, " — ")
      .replace(/:\s+/g, ": ")
      .replace(/,{2,}/g, ",")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " ");
  }

  const parts = cleaned
    .split(/(?<=[\.\?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ssmlBody = parts.map((s) => emphasisLead(s, 3)).join('<break time="240ms"/>');

  return `<speak>
    <prosody rate="fast" pitch="+8%" volume="medium">
      ${ssmlBody}
    </prosody>
  </speak>`;
}

function emphasisLead(sentence = "", n = 3) {
  const tokens = sentence.split(/\s+/).filter(Boolean);
  const lead = tokens.slice(0, n).join(" ");
  const tail = tokens.slice(n).join(" ");
  const leadEsc = escapeSSML(lead);
  const tailEsc = escapeSSML(tail);
  return tail
    ? `<emphasis level="moderate">${leadEsc}</emphasis> ${tailEsc}`
    : `<emphasis level="moderate">${leadEsc}</emphasis>`;
}

function escapeSSML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
