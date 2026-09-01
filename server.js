import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.BRIDGE_TOKEN;
const WEBHOOK_SECRET = process.env.BRIDGE_WEBHOOK_SECRET;
const DATA_DIR = process.env.BRIDGE_DATA_DIR || "/data/sessions";
const PAIRING_TTL_MS = parseInt(process.env.BRIDGE_PAIRING_TTL_MS || "150000");

if (!TOKEN || !WEBHOOK_SECRET) {
  console.error("Faltam BRIDGE_TOKEN e/ou BRIDGE_WEBHOOK_SECRET.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const app = express();
app.use(express.json({ limit: "10mb" }));

const sessions = new Map();
let stopped = false;

process.on("SIGTERM", () => {
  stopped = true;
});

process.on("SIGINT", () => {
  stopped = true;
  process.exit(0);
});

function metaPath(ref) { return path.join(DATA_DIR, ref, "meta.json"); }

function saveMeta(ref, meta) {
  fs.mkdirSync(path.join(DATA_DIR, ref), { recursive: true });
  fs.writeFileSync(metaPath(ref), JSON.stringify(meta));
}

function loadMeta(ref) {
  try { return JSON.parse(fs.readFileSync(metaPath(ref), "utf8")); } catch { return null; }
}

async function postWebhook(webhookUrl, event) {
  if (!webhookUrl) return;
  const raw = JSON.stringify(event);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex");
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-squadia-signature": `sha256=${signature}` },
      body: raw,
    });
  } catch (e) { logger.error({ e }, "webhook failed"); }
}

function textOf(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption || null;
}

function typeOf(msg) {
  const m = msg.message || {};
  if (m.audioMessage) return "audio";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  return "text";
}

async function startSession(ref, { externalId, phone, webhookUrl, isNewSession = false }) {
  if (stopped) return null;
  const folder = path.join(DATA_DIR, ref);
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: Browsers.ubuntu("Chrome"),
    generateHighQualityLinkPreview: true,
    shouldSyncHistoryMessage: false,
    syncFullHistory: false,
  });
  const entry = {
    sock, externalId, phone, webhookUrl,
    status: state.creds?.registered ? "connecting" : "pairing",
    pairingCode: null,
    pairingCodeExpiry: null,
    media: new Map(),
    qrReceived: false,
  };
  sessions.set(ref, entry);
  saveMeta(ref, { externalId, phone, webhookUrl });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (stopped) return;
    const { connection, lastDisconnect, qr } = u;
    
    // Captura QR code
    if (qr) {
      entry.qrReceived = true;
      logger.info({ ref }, "QR code received");
    }
    
    if (connection === "open") {
      entry.status = "connected";
      entry.pairingCode = null;
      entry.pairingCodeExpiry = null;
      await postWebhook(webhookUrl, {
        type: "status", externalId, status: "connected",
        phone: sock.user?.id?.split(":")?.[0] || phone,
      });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      entry.status = loggedOut ? "disconnected" : "connecting";
      await postWebhook(webhookUrl, {
        type: "status", externalId, status: entry.status,
        error: loggedOut ? "Sessão encerrada no aparelho." : null,
      });
      if (!loggedOut && !stopped) {
        setTimeout(() => {
          startSession(ref, { externalId, phone, webhookUrl, isNewSession: false }).catch((e) => logger.error({ e }, "reconnect failed"));
        }, 3000);
      } else {
        sessions.delete(ref);
      }
    }
  });
  sock.ev.on("chats.upsert", async (chats) => {
    if (stopped) return;
    await postWebhook(webhookUrl, {
      type: "chats", externalId,
      chats: chats.map((c) => ({
        chatId: c.id,
        name: c.name || null,
        isGroup: c.id.endsWith("@g.us"),
        unread: c.unreadCount || 0,
        lastAt: c.conversationTimestamp ? new Date(Number(c.conversationTimestamp) * 1000).toISOString() : null,
        preview: null,
      })),
    });
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (stopped) return;
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const chatId = msg.key.remoteJid;
      if (!chatId || chatId === "status@broadcast") continue;
      const mtype = typeOf(msg);
      let mediaRef = null;
      if (["audio", "image", "video", "document"].includes(mtype)) {
        mediaRef = randomUUID();
        entry.media.set(mediaRef, msg);
        if (entry.media.size > 300) entry.media.delete(entry.media.keys().next().value);
      }
      await postWebhook(webhookUrl, {
        type: "message", externalId,
        message: {
          chatId,
          chatName: msg.pushName || null,
          isGroup: chatId.endsWith("@g.us"),
          waMessageId: msg.key.id,
          fromMe: !!msg.key.fromMe,
          author: msg.pushName || null,
          body: textOf(msg),
          type: mtype,
          mediaRef,
          sentAt: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
        },
      });
    }
  });
  
  if (isNewSession && !state.creds?.registered && phone) {
    // Sistema de 3 tentativas com backoff
    let attempts = 0;
    const maxAttempts = 3;
    const requestPairingCode = async () => {
      if (stopped || attempts >= maxAttempts) return;
      
      try {
        // Aguarda o QR code ser recebido
        if (!entry.qrReceived) {
          logger.info({ ref, attempts }, "Aguardando QR code...");
          await new Promise(r => setTimeout(r, 2000));
          if (!entry.qrReceived && attempts === 0) {
            attempts++;
            return requestPairingCode();
          }
        }
        
        attempts++;
        logger.info({ ref, attempts }, "Solicitando código de pareamento");
        const code = await sock.requestPairingCode(phone.replace(/\D/g, ""));
        entry.pairingCode = code;
        entry.pairingCodeExpiry = Date.now() + PAIRING_TTL_MS;
        await postWebhook(webhookUrl, { type: "status", externalId, status: "pairing", phone, pairingCodeExpiry: entry.pairingCodeExpiry });
      } catch (e) {
        logger.warn({ e, ref, attempts }, "Tentativa de pareamento falhou");
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000 * attempts)); // Backoff exponencial
          return requestPairingCode();
        } else {
          logger.error({ e, ref }, "Todas as tentativas de pareamento falharam");
          entry.status = "error";
          await postWebhook(webhookUrl, {
            type: "status", externalId, status: "error",
            error: "Não foi possível gerar o código de pareamento após 3 tentativas.",
          });
        }
      }
    };
    
    // Aguarda QR code e então solicita código de pareamento
    setTimeout(requestPairingCode, 3000);
  }
  
  return entry;
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, version: 2, contract: "v2", sessions: sessions.size }));

app.post("/sessions", async (req, res) => {
  if (stopped) return res.status(503).json({ error: "server stopping" });
  const { externalId, phone, webhookUrl } = req.body || {};
  if (!externalId || !phone || !webhookUrl) {
    return res.status(400).json({ error: "externalId, phone e webhookUrl são obrigatórios" });
  }
  const ref = `u_${String(externalId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const existing = sessions.get(ref);
  if (existing) {
    try { existing.sock.end(); } catch {}
    sessions.delete(ref);
  }
  try {
    const entry = await startSession(ref, { externalId, phone, webhookUrl, isNewSession: true });
    if (!entry) return res.status(503).json({ error: "server stopping" });
    // Timeout aumentado para 45s para aguardar código de pareamento
    for (let i = 0; i < 150 && !entry.pairingCode && entry.status === "pairing"; i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    res.json({ sessionRef: ref, pairingCode: entry.pairingCode, pairingCodeExpiry: entry.pairingCodeExpiry, status: entry.status });
  } catch (e) {
    logger.error({ e }, "start session failed");
    res.status(500).json({ error: "não foi possível iniciar a sessão" });
  }
});

app.get("/sessions/:ref/status", async (req, res) => {
  const entry = sessions.get(req.params.ref);
  if (!entry) {
    const meta = loadMeta(req.params.ref);
    if (meta) {
      return res.json({ status: "disconnected", phone: meta.phone, pairingCode: null });
    }
    return res.status(404).json({ error: "not found" });
  }
  
  // Verifica se código expirou
  if (entry.pairingCodeExpiry && Date.now() > entry.pairingCodeExpiry) {
    entry.pairingCode = null;
    entry.pairingCodeExpiry = null;
  }
  
  res.json({
    status: entry.status,
    phone: entry.sock.user?.id?.split(":")?.[0] || entry.phone,
    pairingCode: entry.pairingCode,
    pairingCodeExpiry: entry.pairingCodeExpiry,
  });
});

app.get("/sessions/:ref", async (req, res) => {
  const entry = sessions.get(req.params.ref);
  if (!entry) {
    const meta = loadMeta(req.params.ref);
    if (meta) {
      return res.json({ status: "disconnected", phone: meta.phone, pairingCode: null });
    }
    return res.status(404).json({ error: "not found" });
  }
  
  // Verifica se código expirou
  if (entry.pairingCodeExpiry && Date.now() > entry.pairingCodeExpiry) {
    entry.pairingCode = null;
    entry.pairingCodeExpiry = null;
  }
  
  res.json({
    status: entry.status,
    phone: entry.sock.user?.id?.split(":")?.[0] || entry.phone,
    pairingCode: entry.pairingCode,
    pairingCodeExpiry: entry.pairingCodeExpiry,
  });
});

app.delete("/sessions/:ref", async (req, res) => {
  const ref = req.params.ref;
  const entry = sessions.get(ref);
  if (entry) {
    try { await entry.sock.logout(); } catch {}
    sessions.delete(ref);
  }
  fs.rmSync(path.join(DATA_DIR, ref), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post("/sessions/:ref/messages", async (req, res) => {
  if (stopped) return res.status(503).json({ error: "server stopping" });
  const entry = sessions.get(req.params.ref);
  if (!entry || entry.status !== "connected") {
    return res.status(409).json({ error: "sessão não conectada" });
  }
  const { chatId, text, mediaUrl, mediaType, filename } = req.body || {};
  if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });
  try {
    let payload;
    if (mediaUrl) {
      const kind = (mediaType || "document").split("/")[0];
      if (kind === "image") payload = { image: { url: mediaUrl }, caption: text || undefined };
      else if (kind === "video") payload = { video: { url: mediaUrl }, caption: text || undefined };
      else if (kind === "audio") payload = { audio: { url: mediaUrl }, mimetype: mediaType };
      else payload = {
        document: { url: mediaUrl },
        mimetype: mediaType || "application/octet-stream",
        fileName: filename || "arquivo",
        caption: text || undefined,
      };
    } else {
      payload = { text: text || "" };
    }
    const sent = await entry.sock.sendMessage(chatId, payload);
    res.json({ waMessageId: sent?.key?.id || null });
  } catch (e) {
    logger.error({ e }, "send failed");
    res.status(500).json({ error: "falha ao enviar" });
  }
});

app.get("/sessions/:ref/media/:mediaRef", async (req, res) => {
  const entry = sessions.get(req.params.ref);
  if (!entry) return res.status(404).json({ error: "not found" });
  const msg = entry.media.get(req.params.mediaRef);
  if (!msg) return res.status(404).json({ error: "mídia indisponível" });
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: entry.sock.updateMediaMessage });
    const m = msg.message || {};
    const mimeType = m.audioMessage?.mimetype || m.imageMessage?.mimetype ||
      m.videoMessage?.mimetype || m.documentMessage?.mimetype || "application/octet-stream";
    res.json({ base64: buffer.toString("base64"), mimeType, filename: m.documentMessage?.fileName || null });
  } catch (e) {
    logger.error({ e }, "media download failed");
    res.status(500).json({ error: "falha ao baixar mídia" });
  }
});

if (!stopped) {
  for (const ref of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
    const meta = loadMeta(ref);
    if (meta) startSession(ref, { ...meta, isNewSession: false }).catch((e) => logger.error({ e }, `revive ${ref} failed`));
  }
}

console.log("🚀 SquadIA WhatsApp bridge - Contrato v2");
app.listen(PORT, () => console.log(`✓ Bridge listening on :${PORT}`));
