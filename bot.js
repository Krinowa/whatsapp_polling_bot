"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client, LocalAuth, Poll } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// Suggestion collection is manual: only the creator's !start publishes a poll.
const MAX_OPTIONS = 12;
const MAX_OPTION_CHARS = 100;
const MAX_QUESTION_CHARS = 255;
const DATA_FILE = path.join(__dirname, "sessions.json");

const sessions = new Map(); // chatId -> { question, options, optionAuthors, creator }
const publishing = new Set();

// Startup diagnostics: authentication and readiness are different stages.
// These logs help identify Chromium closing or WhatsApp Web failing to load.
let clientReady = false;
let browserDiagnosticsAttached = false;
let pageDiagnosticsAttached = false;
let initializationSettled = false;
let shuttingDown = false;

const http = require("node:http");

const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      // The HTTP process can run while WhatsApp itself is stuck initializing.
      // Return 503 until the official `ready` event fires.
      res.writeHead(clientReady ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(
        JSON.stringify({
          status: clientReady ? "ready" : "not_ready",
          whatsapp_ready: clientReady,
        }),
      );
    }

    res.writeHead(404);
    res.end("Not Found");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Health server running on port ${PORT}`);
  });

process.on("uncaughtExceptionMonitor", (error) => {
  console.error("[fatal] Uncaught exception:", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[fatal] Unhandled promise rejection:", error);
  process.exitCode = 1;
});
process.on("beforeExit", (code) => {
  if (!clientReady) {
    console.error(
      `[startup] Node has no remaining work (exit code ${code}), but WhatsApp never became ready.`,
    );
    console.error(
      "[startup] Chromium may have closed; check browser diagnostics above.",
    );
  }
});
process.on("exit", (code) => {
  if (!clientReady)
    console.error(`[startup] Process exited before ready (code ${code}).`);
});

// Message#getChat() calls getChatById(), which can fail with "r: r"
// on some WhatsApp Web versions. Read the destination from the message
// itself, tolerating both older `_serialized` and newer `$1` ID formats.
function getWid(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  if (typeof value._serialized === "string") return value._serialized;
  if (typeof value.$1 === "string") return value.$1;
  if (typeof value.user === "string" && typeof value.server === "string") {
    return `${value.user}@${value.server}`;
  }
  return null;
}

function getGroupChatId(msg) {
  const candidates = msg.fromMe
    ? [msg.to, msg.rawData?.to, msg.id?.remote, msg.rawData?.id?.remote]
    : [msg.from, msg.rawData?.from, msg.id?.remote, msg.rawData?.id?.remote];
  for (const candidate of candidates) {
    const chatId = getWid(candidate);
    if (chatId && chatId.endsWith("@g.us")) return chatId;
  }
  return null;
}

// Keep creator matching strict. Falling back to the group ID for members
// with missing author data could let other members cancel their poll.
function getSenderId(msg) {
  if (msg.fromMe) return "linked-account";
  for (const candidate of [
    msg.author,
    msg.rawData?.author,
    msg.id?.participant,
    msg.rawData?.id?.participant,
  ]) {
    const senderId = getWid(candidate);
    if (senderId) return senderId;
  }
  return null;
}

function loadSessions() {
  if (!fs.existsSync(DATA_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(saved)) throw new Error("sessions.json is not a list");
  for (const item of saved) {
    if (
      typeof item.chatId === "string" &&
      typeof item.question === "string" &&
      typeof item.creator === "string" &&
      Array.isArray(item.options)
    ) {
      sessions.set(item.chatId, {
        question: item.question,
        options: item.options,
        // Old drafts store plain strings only. Keep them intact; the creator
        // can remove legacy options whose original suggester is unknown.
        optionAuthors: item.options.map((_, index) =>
          typeof item.optionAuthors?.[index] === "string"
            ? item.optionAuthors[index]
            : null,
        ),
        creator: item.creator,
      });
    }
  }
}

function saveSessions() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      [...sessions].map(([chatId, session]) => ({ chatId, ...session })),
      null,
      2,
    ),
  );
  fs.renameSync(tmp, DATA_FILE);
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
    ],
  },
});

async function send(chatId, text) {
  await client.sendMessage(chatId, text);
}

async function finalizePoll(chatId) {
  if (publishing.has(chatId)) return;
  const session = sessions.get(chatId);
  if (!session) return;

  // Keep the draft open until it has at least two suggestions.
  if (session.options.length < 2) {
    await send(
      chatId,
      "Add at least 2 different options before using !start. Suggestions stay open until you start or cancel the poll.",
    );
    return;
  }

  publishing.add(chatId);
  try {
    await client.sendMessage(
      chatId,
      new Poll(session.question, session.options, {
        allowMultipleAnswers: false,
      }),
    );
    console.log(`Poll published in ${chatId}: ${session.question}`);
    sessions.delete(chatId);
    saveSessions();
  } catch (error) {
    console.error(`Unable to publish poll for ${chatId}:`, error);
    // Keep the choices saved. !start lets the creator retry after an error.
    try {
      await send(
        chatId,
        "⚠️ Could not publish the poll. Creator: send !start to retry.",
      );
    } catch (messageError) {
      console.error("Unable to send failure notice:", messageError);
    }
  } finally {
    publishing.delete(chatId);
  }
}

// Temporary workaround for whatsapp-web.js 1.34.7: on some restored sessions,
// a transient Chromium iframe disappears during the library's exposeFunction
// calls in attachEventListeners(). The upstream authenticated callback can
// reject without delivering the error to client.initialize().catch(...).
// Retry ONLY those transient browser/frame failures; do not fabricate READY.
function installTransientListenerSetupRetry(waClient) {
  const originalAttach = waClient.attachEventListeners.bind(waClient);
  waClient.attachEventListeners = async (...args) => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await originalAttach(...args);
        if (attempt > 1) {
          console.log(
            `[startup] Message listener setup recovered on attempt ${attempt}.`,
          );
        }
        return;
      } catch (error) {
        const message = String(error?.message ?? error);
        console.error(
          `[startup] Message listener setup failed (${attempt}/${maxAttempts}):`,
          message.slice(0, 500),
        );
        const transient =
          /Target closed|Frame was detached|No frame for given id|Execution context was destroyed|Cannot find context with specified id|Protocol error \(Runtime\.addBinding\)/i.test(
            message,
          );
        const browserAlive = Boolean(
          waClient.pupBrowser?.isConnected() &&
          waClient.pupPage &&
          !waClient.pupPage.isClosed(),
        );
        if (!transient || !browserAlive || attempt === maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  };
}

installTransientListenerSetupRetry(client);

client.on("qr", (qr) => {
  console.log("Scan this QR in WhatsApp > Linked Devices > Link a Device:");
  qrcode.generate(qr, { small: true });
});

function attachBrowserDiagnostics() {
  const browser = client.pupBrowser;
  if (browser && !browserDiagnosticsAttached) {
    browserDiagnosticsAttached = true;
    browser.on("disconnected", () => {
      console.error(
        "[browser] Chromium disconnected. This prevents the bot from becoming ready.",
      );
    });
    console.log(`[browser] Chromium connected: ${browser.isConnected()}`);
  }

  const page = client.pupPage;
  if (page && !pageDiagnosticsAttached) {
    pageDiagnosticsAttached = true;
    page.on("pageerror", (error) =>
      console.error("[page] JavaScript error:", error),
    );
    page.on("error", (error) =>
      console.error("[page] Browser page error:", error),
    );
    page.on("close", () => console.error("[page] WhatsApp Web page closed."));
    console.log(`[browser] WhatsApp Web page open: ${!page.isClosed()}`);
  }
}

// Temporary diagnostics: capture errors in page evaluations that happen AFTER
// authentication. The library may catch/reject them inside exposed callbacks,
// so they don't always reach the .initialize().catch(...) handler.
function attachInitializationDiagnostics() {
  const page = client.pupPage;
  if (!page || page.__botEvaluateDiagnostic) return;
  const originalEvaluate = page.evaluate.bind(page);
  page.evaluate = async (...args) => {
    try {
      return await originalEvaluate(...args);
    } catch (error) {
      console.error(
        "[startup] WhatsApp page evaluation failed:",
        String(error?.message ?? error).slice(0, 500),
      );
      throw error;
    }
  };
  page.__botEvaluateDiagnostic = true;
}

client.on("authenticated", () => {
  console.log("Authenticated (saved WhatsApp login accepted).");
  attachBrowserDiagnostics();
  attachInitializationDiagnostics();
});
client.on("change_state", (state) => console.log("[whatsapp state]", state));

client.on("auth_failure", (err) =>
  console.error("Authentication failed:", err),
);
client.on("disconnected", (reason) =>
  console.warn("WhatsApp disconnected:", reason),
);

client.on("ready", () => {
  clientReady = true;
  attachBrowserDiagnostics();
  console.log(
    "✅ WhatsApp Voting Bot ready. Suggestions stay open until !start.",
  );
});

client.on("message_create", async (msg) => {
  // message_create includes commands sent by the linked WhatsApp account itself.
  // The bot's own responses do not start with '!', so they won't cause a loop.
  if (typeof msg.body !== "string") return;
  const input = msg.body.trim();
  if (!input.startsWith("!")) return;
  console.log(
    `[command received] ${input.split(/\s+/, 1)[0]} (fromMe=${msg.fromMe})`,
  );

  const space = input.search(/\s/);
  const command = (space === -1 ? input : input.slice(0, space)).toLowerCase();
  const argument = (space === -1 ? "" : input.slice(space).trim()).replace(
    /\s+/g,
    " ",
  );
  if (
    ![
      "!poll",
      "!add",
      "!remove",
      "!options",
      "!extend",
      "!start",
      "!cancel",
      "!help",
    ].includes(command)
  )
    return;

  try {
    // Avoid msg.getChat(): it invokes getChatById(), which currently fails
    // for some WhatsApp Web builds with a cryptic Puppeteer `r: r` error.
    const chatId = getGroupChatId(msg);
    if (!chatId) {
      console.log(
        `[command ignored] Not a group chat (fromMe=${msg.fromMe}, from=${msg.from}, to=${msg.to}).`,
      );
      return; // Never respond in private chats.
    }
    const senderId = getSenderId(msg);
    const session = sessions.get(chatId);

    if (command === "!help") {
      await send(
        chatId,
        "🗳️ Voting commands:\n" +
          "!poll <question> — begin collecting suggestions\n" +
          "!add <option> — suggest an answer\n" +
          "!remove <number or name> — remove your suggestion (creator can remove any)\n" +
          "!options — see current suggestions\n" +
          "!start — publish the poll (creator only)\n" +
          "!cancel — cancel (creator only)",
      );
      return;
    }

    if (command === "!poll") {
      if (!senderId) {
        console.warn("[command ignored] Could not identify poll creator.");
        return;
      }
      if (session) {
        await send(
          chatId,
          "There is already a poll being prepared. Use !options to see it.",
        );
        return;
      }
      if (!argument || argument.length > MAX_QUESTION_CHARS) {
        await send(
          chatId,
          `Use: !poll <question> (up to ${MAX_QUESTION_CHARS} characters).`,
        );
        return;
      }
      sessions.set(chatId, {
        question: argument,
        options: [],
        optionAuthors: [],
        creator: senderId,
      });
      saveSessions();
      await send(
        chatId,
        `🗳️ *${argument}*\n\n` +
          "Suggestions are open with no deadline.\n" +
          "Anyone can send !add <option>.\n" +
          "Use !options to see them and !remove <number> to correct your own suggestion.\n" +
          "The creator sends !start to publish or !cancel to cancel.",
      );
      return;
    }

    if (!session) {
      await send(
        chatId,
        "No poll is collecting suggestions. Use !poll <question> to create one.",
      );
      return;
    }

    if (publishing.has(chatId)) {
      await send(chatId, "This poll is being published.");
      return;
    }

    if (command === "!add") {
      if (!senderId) {
        await send(
          chatId,
          "Could not identify your WhatsApp account. Please try again.",
        );
        return;
      }
      if (!argument || argument.length > MAX_OPTION_CHARS) {
        await send(
          chatId,
          `Use: !add <option> (up to ${MAX_OPTION_CHARS} characters).`,
        );
        return;
      }
      if (
        session.options.some(
          (option) =>
            option.toLocaleLowerCase() === argument.toLocaleLowerCase(),
        )
      ) {
        await send(chatId, "That option has already been suggested.");
        return;
      }
      if (session.options.length >= MAX_OPTIONS) {
        await send(
          chatId,
          `Maximum ${MAX_OPTIONS} options reached. The creator can send !start now.`,
        );
        return;
      }
      session.options.push(argument);
      session.optionAuthors.push(senderId);
      saveSessions();
      await send(
        chatId,
        `✅ Added: ${argument} (${session.options.length}/${MAX_OPTIONS})`,
      );
      return;
    }

    if (command === "!remove") {
      if (!argument) {
        await send(
          chatId,
          "Use !options to see the list, then !remove 2 or !remove Sushi.",
        );
        return;
      }
      // A number refers to the *current* 1-based list; a name must match an
      // existing suggestion. Never remove the first option on invalid input.
      const optionIndex = /^\d+$/.test(argument)
        ? Number(argument) - 1
        : session.options.findIndex(
            (name) => name.toLocaleLowerCase() === argument.toLocaleLowerCase(),
          );
      if (
        !Number.isSafeInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= session.options.length
      ) {
        await send(
          chatId,
          "Option not found. Send !options to see the current numbered list.",
        );
        return;
      }
      const isCreator = Boolean(senderId && senderId === session.creator);
      const isAuthor = Boolean(
        senderId && senderId === session.optionAuthors[optionIndex],
      );
      if (!isCreator && !isAuthor) {
        await send(
          chatId,
          "You can only remove suggestions you added. The poll creator can remove any suggestion.",
        );
        return;
      }
      const [removed] = session.options.splice(optionIndex, 1);
      session.optionAuthors.splice(optionIndex, 1);
      saveSessions();
      await send(
        chatId,
        `🗑️ Removed: ${removed}\nUse !add <option> to submit a corrected choice.`,
      );
      return;
    }

    if (command === "!options") {
      const list = session.options.length
        ? session.options.map((name, i) => `${i + 1}. ${name}`).join("\n")
        : "No suggestions yet.";
      await send(
        chatId,
        `📋 *${session.question}*\n${list}\n\nSuggestions are open until the creator sends !start.`,
      );
      return;
    }

    if (!senderId || senderId !== session.creator) {
      await send(
        chatId,
        "Only the person who created this poll can use that command.",
      );
      return;
    }

    if (command === "!extend") {
      await send(
        chatId,
        "⏳ Suggestions already have no time limit. Send !start whenever you are ready to publish.",
      );
    } else if (command === "!cancel") {
      sessions.delete(chatId);
      saveSessions();
      await send(chatId, "🚫 Suggestion collection cancelled.");
    } else if (command === "!start") {
      await finalizePoll(chatId);
    }
  } catch (error) {
    console.error("Failed to handle a group command:", error);
  }
});

try {
  loadSessions();
} catch (error) {
  console.error(
    "Cannot read saved sessions. Fix sessions.json before starting:",
    error,
  );
  process.exit(1);
}

// Ctrl+C normally kills the Node process immediately. Close the browser
// cleanly instead, giving Chromium a chance to flush the saved LocalAuth
// profile. This improves shutdown hygiene, but cannot prevent every upstream
// WhatsApp Web "authenticated but not ready" bug.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: closing WhatsApp Web cleanly...`);
  const deadline = setTimeout(() => {
    console.error(
      "[shutdown] Browser did not close in 10 seconds. Forcing exit.",
    );
    process.exit(1);
  }, 10_000);
  try {
    if (client.pupBrowser?.isConnected()) {
      await client.destroy();
    }
    console.log("[shutdown] Browser closed. Saved polls are preserved.");
    process.exitCode = 0;
  } catch (error) {
    console.error("[shutdown] Error while closing Chromium:", error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    // Do not leave stray browser handles running after Ctrl+C.
    process.exit(process.exitCode);
  }
}
process.on("SIGINT", () => shutdown("Ctrl+C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("[startup] Initializing WhatsApp Web...");

// This diagnostic does NOT start a voting timer or publish anything.
// It only warns if startup has not completed. Unref keeps it from hiding
// a browser failure by artificially keeping Node alive.
const startupWarning = setTimeout(() => {
  if (!clientReady) {
    console.error(
      "[startup] Still not ready. Browser connected:",
      client.pupBrowser ? client.pupBrowser.isConnected() : "not launched",
    );
    console.error(
      "[startup] Page closed:",
      client.pupPage ? client.pupPage.isClosed() : "not opened",
    );
    console.error(
      "[startup] Client.initialize() settled:",
      initializationSettled,
    );
    console.error(
      "[startup] Library version:",
      require("whatsapp-web.js/package.json").version,
    );
    console.error("[startup] Internal setup:", {
      hasClientInfo: Boolean(client.info),
      hasMessageInterface: Boolean(client.interface),
    });
    // Read only high-level status: no messages, phone numbers or auth tokens.
    // Newer wwebjs releases do NOT require window.Store; don't use it as a
    // readiness test. The official 'ready' event remains authoritative.
    const page = client.pupPage;
    if (page && !page.isClosed()) {
      page
        .evaluate(() => {
          let socket = null;
          try {
            socket = window.require("WAWebSocketModel").Socket;
          } catch (_) {
            /* internal module may not yet be available */
          }
          return {
            pageReady: document.readyState,
            webVersion: String(window.Debug?.VERSION ?? "unknown"),
            hasWWebJS: Boolean(window.WWebJS),
            hasAuthStore: Boolean(window.AuthStore),
            socketState: socket?.state ?? "unknown",
            hasSynced: socket?.hasSynced ?? "unknown",
            hasMessageEventBridge:
              typeof window.onAddMessageEvent === "function",
          };
        })
        .then((status) => {
          console.error("[startup] WhatsApp page state:", status);
        })
        .catch((error) => {
          console.error(
            "[startup] Could not inspect WhatsApp page:",
            String(error?.message ?? error).slice(0, 300),
          );
        });
    }
    console.error(
      "[startup] Authenticated but not ready: check library version, internal setup and page state above.",
    );
  }
}, 20_000);
startupWarning.unref();

client
  .initialize()
  .then(() => {
    initializationSettled = true;
    console.log("[startup] Client.initialize() completed.");
  })
  .catch((error) => {
    initializationSettled = true;
    console.error("[startup] Could not initialize WhatsApp:", error);
    process.exitCode = 1;
  });
