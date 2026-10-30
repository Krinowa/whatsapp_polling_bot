import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error(
    "Missing ADMIN_PASSWORD (at least 12 characters). Set it in Render Environment or your shell.",
  );
  process.exit(1);
}

// For testing, files are saved locally. Render Free erases runtime files on a
// restart/redeploy/spin-down. Use external encrypted storage for durability.
const AUTH_DIR = path.join(__dirname, "baileys_auth");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const MAX_OPTIONS = 12;
const MAX_OPTION_CHARS = 100;
const MAX_QUESTION_CHARS = 255;
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

let socket = null;
let socketGeneration = 0;
let reconnectTimer = null;
let qrGeneration = 0;
let status = "starting";
let qrDataUrl = null;
let lastError = null;
let shuttingDown = false;
const sessions = new Map();
const publishing = new Set();
const processedMessages = new Map();

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  if (!Array.isArray(saved))
    throw new Error("sessions.json must contain an array");
  for (const entry of saved) {
    if (
      typeof entry.chatId !== "string" ||
      typeof entry.question !== "string" ||
      typeof entry.creator !== "string" ||
      !Array.isArray(entry.options)
    )
      continue;
    sessions.set(entry.chatId, {
      question: entry.question,
      creator: entry.creator,
      options: entry.options,
      optionAuthors: entry.options.map(
        (_, i) => entry.optionAuthors?.[i] ?? null,
      ),
    });
  }
}

function saveSessions() {
  const temp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify(
      [...sessions].map(([chatId, session]) => ({ chatId, ...session })),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.renameSync(temp, SESSIONS_FILE);
}

// Protected Basic Auth on HTTPS. Do not put the QR code in public URLs or logs.
function matchesSecret(given, expected) {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function isAdmin(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    return (
      matchesSecret(decoded.slice(0, sep), ADMIN_USER) &&
      matchesSecret(decoded.slice(sep + 1), ADMIN_PASSWORD)
    );
  } catch {
    return false;
  }
}

const loginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Voting Bot Login</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7f6;color:#17211b;min-height:100vh;margin:0;display:grid;place-items:center}
main{background:white;border:1px solid #dfe8e3;border-radius:18px;padding:28px;max-width:410px;width:calc(100% - 48px);text-align:center;box-shadow:0 12px 35px #1233}
h1{font-size:23px;margin:4px 0 14px}p{line-height:1.5;color:#56645a}#status{font-weight:650;margin:16px 0}img{width:280px;max-width:100%;height:auto;background:white;border:1px solid #eee;border-radius:9px}small{color:#607064}
</style></head><body><main><h1>WhatsApp Voting Bot</h1><div id="status">Connecting…</div><img id="qr" alt="WhatsApp linking QR code" hidden>
<p id="guide">Open WhatsApp on your phone → Linked Devices → Link a Device.</p>
<small>Private admin page. The QR code expires and refreshes automatically.</small></main>
<script>
async function update(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('Status '+r.status);const d=await r.json();
const labels={starting:'Starting bot…',connecting:'Connecting to WhatsApp…',qr:'Scan this QR code',connected:'✅ WhatsApp connected',logged_out:'Session logged out; restart pairing',disconnected:'Disconnected — reconnecting…',error:'Connection error'};
document.getElementById('status').textContent=labels[d.status]||d.status;
const im=document.getElementById('qr');im.hidden=!d.qr; if(d.qr)im.src=d.qr;else im.removeAttribute('src');
document.getElementById('guide').textContent=d.status==='connected'?'Bot is connected. Use !help in your WhatsApp group.':(d.error||'Open WhatsApp on your phone → Linked Devices → Link a Device.');
}catch(e){document.getElementById('status').textContent='Cannot read bot status';}}
update();setInterval(update,3000);
</script></body></html>`;

http
  .createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("alive"); // Render liveness, not WhatsApp readiness.
    }
    if (req.url === "/ready") {
      const ready = status === "connected";
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ready }));
    }
    if (req.url !== "/login" && req.url !== "/api/status" && req.url !== "/") {
      res.writeHead(404);
      return res.end("Not found");
    }
    if (!isAdmin(req)) {
      res.setHeader(
        "WWW-Authenticate",
        'Basic realm="WhatsApp Bot Admin", charset="UTF-8"',
      );
      res.writeHead(401);
      return res.end("Authentication required");
    }
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ status, qr: qrDataUrl, error: lastError }),
      );
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage);
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log(`[http] Listening on ${PORT}; open /login`),
  );

function messageText(message) {
  let m = message?.message;
  if (!m) return "";
  m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return (m.conversation || m.extendedTextMessage?.text || "").trim();
}

function isFresh(message) {
  // Ignore replayed historic commands after reconnect. Own messages on other
  // linked devices may come through as 'append'; recent ones are allowed.
  const raw = message.messageTimestamp;
  const seconds =
    typeof raw === "object" &&
    raw !== null &&
    typeof raw.toNumber === "function"
      ? raw.toNumber()
      : Number(raw);
  return (
    Number.isFinite(seconds) &&
    seconds > Date.now() / 1000 - 120 &&
    seconds < Date.now() / 1000 + 60
  );
}

function getSender(message) {
  // Compatible with creator='linked-account' in old sessions.json files.
  if (message.key.fromMe) return "linked-account";
  return message.key.participant || null;
}

async function send(chatId, text) {
  if (status !== "connected" || !socket)
    throw new Error("WhatsApp not connected");
  return socket.sendMessage(chatId, { text });
}

async function publish(chatId) {
  if (publishing.has(chatId)) return;
  const session = sessions.get(chatId);
  if (!session) return;
  if (session.options.length < 2) {
    await send(
      chatId,
      "Add at least two different options before using !start.",
    );
    return;
  }
  publishing.add(chatId);
  try {
    await socket.sendMessage(chatId, {
      poll: {
        name: session.question,
        values: session.options,
        selectableCount: 1,
      },
    });
    sessions.delete(chatId);
    saveSessions();
    console.log("[poll] Published", chatId);
  } catch (error) {
    console.error("[poll] Publication failed:", error.message);
    await send(
      chatId,
      "⚠️ Could not publish poll. Creator can retry !start.",
    ).catch(() => {});
  } finally {
    publishing.delete(chatId);
  }
}

async function handleCommand(message) {
  const chatId = message.key.remoteJid;
  if (typeof chatId !== "string" || !chatId.endsWith("@g.us")) return;
  if (!isFresh(message)) return;
  const text = messageText(message);
  if (!text.startsWith("!")) return;
  const [cmd] = text.split(/\s+/, 1);
  const command = cmd.toLowerCase();
  const argument = text.slice(cmd.length).trim().replace(/\s+/g, " ");
  const known = new Set([
    "!help",
    "!poll",
    "!add",
    "!remove",
    "!options",
    "!start",
    "!cancel",
    "!extend",
  ]);
  if (!known.has(command)) return;
  const sender = getSender(message);
  const session = sessions.get(chatId);
  console.log(
    "[command]",
    command,
    "group:",
    chatId,
    "fromMe:",
    Boolean(message.key.fromMe),
  );

  if (command === "!help")
    return send(
      chatId,
      "🗳️ Voting bot commands:\n!poll <question> — open suggestions\n!add <option> — suggest a choice\n" +
        "!remove <number or name> — delete your own suggestion (creator can delete any)\n" +
        "!options — show suggestions\n!start — publish native poll (creator only)\n!cancel — cancel draft (creator only)",
    );

  if (command === "!poll") {
    if (!sender) return;
    if (session)
      return send(chatId, "A poll is already being prepared. Send !options.");
    if (!argument || argument.length > MAX_QUESTION_CHARS)
      return send(
        chatId,
        `Use !poll <question> (up to ${MAX_QUESTION_CHARS} characters).`,
      );
    sessions.set(chatId, {
      question: argument,
      creator: sender,
      options: [],
      optionAuthors: [],
    });
    saveSessions();
    return send(
      chatId,
      `🗳️ *${argument}*\nSuggestions stay open until the creator sends !start.\nAnyone can !add <option>.`,
    );
  }

  if (!session)
    return send(chatId, "No draft poll. Use !poll <question> first.");
  if (publishing.has(chatId))
    return send(chatId, "The poll is being published.");

  if (command === "!add") {
    if (!sender) return send(chatId, "Could not identify your group account.");
    if (!argument || argument.length > MAX_OPTION_CHARS)
      return send(
        chatId,
        `Use !add <option> (up to ${MAX_OPTION_CHARS} characters).`,
      );
    if (session.options.some((x) => x.toLowerCase() === argument.toLowerCase()))
      return send(chatId, "That option already exists.");
    if (session.options.length >= MAX_OPTIONS)
      return send(chatId, "Maximum 12 options reached.");
    session.options.push(argument);
    session.optionAuthors.push(sender);
    saveSessions();
    return send(
      chatId,
      `✅ Added ${argument} (${session.options.length}/${MAX_OPTIONS})`,
    );
  }

  if (command === "!remove") {
    if (!argument)
      return send(chatId, "Use !options, then !remove 2 or !remove Sushi.");
    const index = /^\d+$/.test(argument)
      ? Number(argument) - 1
      : session.options.findIndex(
          (x) => x.toLowerCase() === argument.toLowerCase(),
        );
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= session.options.length
    )
      return send(chatId, "Option not found. Send !options to see the list.");
    if (
      !sender ||
      (sender !== session.creator && sender !== session.optionAuthors[index])
    )
      return send(
        chatId,
        "You can only delete your own suggestion; the creator can delete any.",
      );
    const [removed] = session.options.splice(index, 1);
    session.optionAuthors.splice(index, 1);
    saveSessions();
    return send(
      chatId,
      `🗑️ Removed ${removed}. Send !add <option> to correct it.`,
    );
  }

  if (command === "!options") {
    const list =
      session.options.map((x, i) => `${i + 1}. ${x}`).join("\n") ||
      "No suggestions yet.";
    return send(
      chatId,
      `📋 *${session.question}*\n${list}\n\nSuggestions stay open until !start.`,
    );
  }

  if (!sender || sender !== session.creator)
    return send(chatId, "Only the poll creator can use that command.");
  if (command === "!extend")
    return send(chatId, "Suggestions are already unlimited until !start.");
  if (command === "!cancel") {
    sessions.delete(chatId);
    saveSessions();
    return send(chatId, "🚫 Draft poll cancelled.");
  }
  if (command === "!start") return publish(chatId);
}

async function connect() {
  if (shuttingDown) return;
  const generation = ++socketGeneration;
  status = "connecting";
  qrDataUrl = null;
  lastError = null;
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: authState,
    browser: Browsers.ubuntu("Voting Bot"),
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: true,
  });
  socket = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (generation !== socketGeneration || status !== "connected") return;
    for (const message of messages) {
      // Only live inbound messages, plus recent own-account commands from the
      // phone, not old history; never process our own echoed bot text.
      if (type !== "notify" && !(message.key.fromMe && type === "append"))
        continue;
      const id = message.key.id;
      const unique = `${message.key.remoteJid}:${id}`;
      if (!id || processedMessages.has(unique)) continue;
      processedMessages.set(unique, Date.now());
      if (processedMessages.size > 2000) {
        const oldest = [...processedMessages.keys()].slice(0, 500);
        oldest.forEach((key) => processedMessages.delete(key));
      }
      try {
        await handleCommand(message);
      } catch (err) {
        console.error("[command] Failed:", err.message);
      }
    }
  });
  sock.ev.on(
    "connection.update",
    async ({ connection, qr, lastDisconnect }) => {
      if (generation !== socketGeneration || shuttingDown) return;
      if (qr) {
        const qrId = ++qrGeneration;
        try {
          const image = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          if (generation === socketGeneration && qrId === qrGeneration) {
            qrDataUrl = image;
            status = "qr";
            console.log("[auth] QR available at protected /login page");
          }
        } catch (err) {
          console.error("[auth] QR generation failed:", err.message);
        }
      }
      if (connection === "open") {
        qrGeneration++;
        qrDataUrl = null;
        status = "connected";
        lastError = null;
        console.log("✅ WhatsApp Voting Bot connected. Try !help in a group.");
      }
      if (connection === "close") {
        qrGeneration++;
        qrDataUrl = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        status = loggedOut ? "logged_out" : "disconnected";
        lastError = loggedOut
          ? "Logged out. Re-pair the WhatsApp account."
          : null;
        console.log(
          "[connection] Closed; code:",
          code,
          "loggedOut:",
          loggedOut,
        );
        if (!loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(
            () => connect().catch(onStartupError),
            3000,
          );
        }
      }
    },
  );
}

function onStartupError(error) {
  status = "error";
  lastError = "Cannot connect; check Render logs.";
  console.error("[startup] Failed:", error);
  if (!shuttingDown) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch(onStartupError), 10000);
  }
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  status = "disconnected";
  try {
    socket?.ws?.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

loadSessions();
console.log("[startup] Initializing WhatsApp via Baileys (no Chromium)...");
connect().catch(onStartupError);
