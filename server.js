/**
 * SquadIA — serviço-ponte do WhatsApp pessoal (modelo Zapia).
 *
 * Contrato (v3):
 *  - LEITURA NUNCA MUDA ESTADO. `GET /sessions/:ref/status` (e `GET /sessions/:ref`)
 *    apenas leem memória/disco. Nunca abrem socket, nunca pedem código novo,
 *    nunca apagam credenciais.
 *  - PAREAMENTO É AÇÃO EXPLÍCITA. Só `POST /sessions` (ou `POST /sessions/:ref/pair`)
 *    inicia um pareamento, com trava de concorrência por sessão e código com validade.
 *  - ESTADO TERMINAL NÃO RESSUSCITA. Sessão encerrada no aparelho limpa as
 *    credenciais e exige novo pareamento consciente.
 *  - Ao subir, só reconecta o que já estava registrado.
 *
 * Nunca marca mensagens como lidas: markOnlineOnConnect = false e nenhum
 * readReceipt é enviado. Só envia mensagens quando o app pede explicitamente.
 */

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.BRIDGE_TOKEN;
const WEBHOOK_SECRET = process.env.BRIDGE_WEBHOOK_SECRET;
const DATA_DIR = process.env.BRIDGE_DATA_DIR || "/data/sessions";
/** Validade do código de pareamento mostrado ao usuário. */
const PAIRING_TTL_MS = Number(process.env.BRIDGE_PAIRING_TTL_MS || 150_000);

if (!TOKEN || !WEBHOOK_SECRET) {
  console.error("Faltam BRIDGE_TOKEN e/ou BRIDGE_WEBHOOK_SECRET.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "10mb" }));

/** sessionRef -> { sock, externalId, phone, webhookUrl, status, pairingCode, pairingExpiresAt, media, stopped } */
const sessions = new Map();
/** sessionRef -> Promise — trava de concorrência do pareamento. */
const pairingLocks = new Map();

// ------------------------------------------------------------------
// Persistência leve (meta.json guarda o último estado conhecido)
// ------------------------------------------------------------------

function sessionDir(ref) {
  return path.join(DATA_DIR, ref);
}

function metaPath(ref) {
  return path.join(sessionDir(ref), "meta.json");
}

function loadMeta(ref) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(ref), "utf8"));
  } catch {
    return null;
  }
}

function saveMeta(ref, patch) {
  const current = loadMeta(ref) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(sessionDir(ref), { recursive: true });
  fs.writeFileSync(metaPath(ref), JSON.stringify(next));
  return next;
}

function isRegistered(ref) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(sessionDir(ref), "creds.json"), "utf8"));
    return !!creds?.registered;
  } catch {
    return false;
  }
}

function wipeCredentials(ref) {
  const dir = sessionDir(ref);
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (file === "meta.json") continue;
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  }
}

function activePairingCode(meta) {
  if (!meta?.pairingCode || !meta.pairingExpiresAt) return null;
  return Date.parse(meta.pairingExpiresAt) > Date.now() ? meta.pairingCode : null;
}

/** Visão pública do estado — só leitura, nunca com efeito colateral. */
function publicState(ref) {
  const entry = sessions.get(ref);
  const meta = loadMeta(ref);
  if (!entry && !meta) return null;
  const pairingCode = entry
    ? entry.pairingExpiresAt && entry.pairingExpiresAt > Date.now()
      ? entry.pairingCode
      : null
    : activePairingCode(meta);
  return {
    status: entry?.status ?? meta?.status ?? "disconnected",
    phone: meta?.phone ?? entry?.phone ?? null,
    pairingCode: pairingCode ?? null,
    pairingExpiresAt: entry?.pairingExpiresAt
      ? new Date(entry.pairingExpiresAt).toISOString()
      : (meta?.pairingExpiresAt ?? null),
    lastError: entry?.lastError ?? meta?.lastError ?? null,
    lastErrorCode: entry?.lastErrorCode ?? meta?.lastErrorCode ?? null,
    registered: isRegistered(ref),
    live: !!entry,
  };
}

// ------------------------------------------------------------------
// Webhooks / eventos
// ------------------------------------------------------------------

async function postWebhook(webhookUrl, event) {
  if (!webhookUrl) return;
  const raw = JSON.stringify(event);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex");
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-squadia-signature": `sha256=${signature}`,
      },
      body: raw,
    });
  } catch (e) {
    logger.error({ e }, "webhook failed");
  }
}

/**
 * Transição de estado: grava em memória, no disco e avisa o app.
 * Toda mudança relevante passa por aqui — é o registro de eventos da ponte.
 */
async function transition(ref, patch) {
  const entry = sessions.get(ref);
  const meta = loadMeta(ref) || {};
  const webhookUrl = patch.webhookUrl ?? entry?.webhookUrl ?? meta.webhookUrl;
  const externalId = patch.externalId ?? entry?.externalId ?? meta.externalId;

  if (entry) {
    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.pairingCode !== undefined) entry.pairingCode = patch.pairingCode;
    if (patch.pairingExpiresAt !== undefined) entry.pairingExpiresAt = patch.pairingExpiresAt;
    if (patch.lastError !== undefined) entry.lastError = patch.lastError;
    if (patch.lastErrorCode !== undefined) entry.lastErrorCode = patch.lastErrorCode;
    if (patch.phone !== undefined) entry.phone = patch.phone;
  }

  saveMeta(ref, {
    externalId,
    webhookUrl,
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.pairingCode !== undefined ? { pairingCode: patch.pairingCode } : {}),
    ...(patch.pairingExpiresAt !== undefined
      ? {
          pairingExpiresAt: patch.pairingExpiresAt
            ? new Date(patch.pairingExpiresAt).toISOString()
            : null,
        }
      : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    ...(patch.lastErrorCode !== undefined ? { lastErrorCode: patch.lastErrorCode } : {}),
  });

  logger.info({ ref, ...patch }, "session transition");

  if (patch.status !== undefined && patch.silent !== true) {
    await postWebhook(webhookUrl, {
      type: "status",
      externalId,
      status: patch.status,
      phone: patch.phone ?? loadMeta(ref)?.phone ?? undefined,
      error: patch.lastError ?? null,
      errorCode: patch.lastErrorCode ?? null,
      pairingExpiresAt: patch.pairingExpiresAt
        ? new Date(patch.pairingExpiresAt).toISOString()
        : null,
    });
  }
}

// ------------------------------------------------------------------
// Mensagens
// ------------------------------------------------------------------

function textOf(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
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

// ------------------------------------------------------------------
// Ciclo de vida da sessão
// ------------------------------------------------------------------

function stopSession(ref) {
  const entry = sessions.get(ref);
  if (!entry) return;
  entry.stopped = true;
  try {
    entry.sock.end();
  } catch {}
  sessions.delete(ref);
}

/**
 * Abre o socket da sessão. `mode`:
 *  - "resume": só retoma credenciais já registradas (nunca pede código).
 *  - "pair": pareamento novo — credenciais limpas + pedido de código.
 */
async function openSocket(ref, { externalId, phone, webhookUrl }, mode) {
  const folder = sessionDir(ref);
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();
  const registeredAlready = !!state.creds?.registered;

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // O pareamento por código só é aceito com assinatura de navegador.
    browser: registeredAlready ? Browsers.macOS("Desktop") : Browsers.ubuntu("Chrome"),
  });

  const entry = {
    sock,
    externalId,
    phone,
    webhookUrl,
    status: registeredAlready ? "connecting" : "pairing",
    pairingCode: null,
    pairingExpiresAt: null,
    lastError: null,
    lastErrorCode: null,
    wsReady: false,
    media: new Map(),
    stopped: false,
    mode,
  };
  sessions.set(ref, entry);
  saveMeta(ref, { externalId, phone, webhookUrl, status: entry.status });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (entry.stopped || sessions.get(ref) !== entry) return;
    const { connection, lastDisconnect } = u;
    if (u.qr) entry.wsReady = true;

    if (connection === "open") {
      await transition(ref, {
        status: "connected",
        pairingCode: null,
        pairingExpiresAt: null,
        lastError: null,
        lastErrorCode: null,
        phone: sock.user?.id?.split(":")[0]?.split("@")[0] || phone,
      });
      return;
    }

    if (connection !== "close") return;

    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;
    const replaced = code === DisconnectReason.connectionReplaced;
    const restartRequired = code === DisconnectReason.restartRequired;
    const registered = !!state.creds?.registered;

    // Estado terminal: nada de ressuscitar em laço.
    if (loggedOut || replaced) {
      stopSession(ref);
      wipeCredentials(ref);
      await transition(ref, {
        status: "disconnected",
        pairingCode: null,
        pairingExpiresAt: null,
        lastErrorCode: loggedOut ? "logged_out" : "connection_replaced",
        lastError: loggedOut
          ? "Sessão encerrada no aparelho. Gere um novo código para reconectar."
          : "A sessão foi assumida por outro dispositivo. Gere um novo código para reconectar.",
      });
      return;
    }

    // Pareamento que fechou antes de registrar: o código morreu junto.
    if (!registered && !restartRequired) {
      stopSession(ref);
      wipeCredentials(ref);
      await transition(ref, {
        status: "disconnected",
        pairingCode: null,
        pairingExpiresAt: null,
        lastErrorCode: "pairing_failed",
        lastError: "O código expirou ou foi recusado. Gere um novo código.",
      });
      return;
    }

    // Queda recuperável: retoma a MESMA sessão registrada, sem novo código.
    await transition(ref, { status: "connecting", lastError: null, lastErrorCode: null });
    const delay = restartRequired ? 400 : 2_000;
    setTimeout(() => {
      if (entry.stopped || sessions.get(ref) !== entry) return;
      entry.stopped = true;
      sessions.delete(ref);
      openSocket(ref, { externalId, phone, webhookUrl }, "resume").catch(async (e) => {
        logger.error({ e, ref }, "resume failed");
        await transition(ref, {
          status: "error",
          lastErrorCode: "resume_failed",
          lastError: "Não foi possível retomar a conexão. Gere um novo código.",
        });
      });
    }, delay);
  });

  sock.ev.on("chats.upsert", async (chats) => {
    await postWebhook(webhookUrl, {
      type: "chats",
      externalId,
      chats: chats.map((c) => ({
        chatId: c.id,
        name: c.name || null,
        isGroup: c.id.endsWith("@g.us"),
        unread: c.unreadCount || 0,
        lastAt: c.conversationTimestamp
          ? new Date(Number(c.conversationTimestamp) * 1000).toISOString()
          : null,
        preview: null,
      })),
    });
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
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
        if (entry.media.size > 300) {
          entry.media.delete(entry.media.keys().next().value);
        }
      }

      await postWebhook(webhookUrl, {
        type: "message",
        externalId,
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
          sentAt: msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
            : new Date().toISOString(),
        },
      });
    }
  });

  return { entry, state, sock };
}

/** Espera o websocket ficar pronto (primeiro QR) antes de pedir o código. */
async function waitForWs(entry, maxMs = 15_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !entry.stopped && !entry.wsReady && entry.status === "pairing") {
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Pareamento explícito, com trava de concorrência por sessão. */
async function requestPairing(ref, { externalId, phone, webhookUrl }) {
  if (pairingLocks.has(ref)) return pairingLocks.get(ref);

  const task = (async () => {
    // Um código novo exige credenciais limpas: restos de tentativa anterior
    // fazem o WhatsApp aceitar e depois rejeitar o código.
    stopSession(ref);
    wipeCredentials(ref);
    saveMeta(ref, {
      externalId,
      phone,
      webhookUrl,
      status: "pairing",
      pairingCode: null,
      pairingExpiresAt: null,
      lastError: null,
      lastErrorCode: null,
    });

    const { entry, state, sock } = await openSocket(ref, { externalId, phone, webhookUrl }, "pair");
    await waitForWs(entry);

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (entry.stopped || sessions.get(ref) !== entry) break;
      if (entry.status === "connected" || sock.user || state.creds?.registered) break;
      try {
        const code = await sock.requestPairingCode(String(phone).replace(/\D/g, ""));
        const expiresAt = Date.now() + PAIRING_TTL_MS;
        await transition(ref, {
          status: "pairing",
          phone,
          pairingCode: code,
          pairingExpiresAt: expiresAt,
          lastError: null,
          lastErrorCode: null,
        });
        return publicState(ref);
      } catch (e) {
        lastError = e;
        logger.error({ e, attempt, ref }, "pairing code failed");
        await new Promise((r) => setTimeout(r, 2_500));
      }
    }

    if (entry.status === "connected" || sock.user || state.creds?.registered) {
      return publicState(ref);
    }

    stopSession(ref);
    await transition(ref, {
      status: "error",
      pairingCode: null,
      pairingExpiresAt: null,
      lastErrorCode: "pairing_code_unavailable",
      lastError: `Não foi possível gerar o código de pareamento.${
        lastError?.message ? ` (${String(lastError.message).slice(0, 120)})` : ""
      }`,
    });
    return publicState(ref);
  })().finally(() => pairingLocks.delete(ref));

  pairingLocks.set(ref, task);
  return task;
}

function refFor(externalId) {
  return `u_${String(externalId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers.authorization !== "Bearer " + TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => {
  const live = [...sessions.values()];
  res.json({
    ok: true,
    version: 3,
    sessions: live.length,
    connected: live.filter((s) => s.status === "connected").length,
    pairing: live.filter((s) => s.status === "pairing").length,
    known: fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).length : 0,
  });
});

/** Pareamento explícito (compatível com o app atual). */
app.post("/sessions", async (req, res) => {
  const { externalId, phone, webhookUrl } = req.body || {};
  if (!externalId || !phone || !webhookUrl) {
    return res.status(400).json({ error: "externalId, phone e webhookUrl são obrigatórios" });
  }
  const ref = refFor(externalId);
  try {
    const state = await requestPairing(ref, { externalId, phone, webhookUrl });
    res.json({ sessionRef: ref, ...state });
  } catch (e) {
    logger.error({ e }, "start session failed");
    res.status(500).json({ error: "não foi possível iniciar a sessão" });
  }
});

/** Mesmo pareamento, endereçado pela sessão já conhecida. */
app.post("/sessions/:ref/pair", async (req, res) => {
  const ref = req.params.ref;
  const meta = loadMeta(ref) || {};
  const externalId = req.body?.externalId ?? meta.externalId;
  const phone = req.body?.phone ?? meta.phone;
  const webhookUrl = req.body?.webhookUrl ?? meta.webhookUrl;
  if (!externalId || !phone || !webhookUrl) {
    return res.status(400).json({ error: "sessão sem dados de pareamento" });
  }
  try {
    const state = await requestPairing(ref, { externalId, phone, webhookUrl });
    res.json({ sessionRef: ref, ...state });
  } catch (e) {
    logger.error({ e }, "pair failed");
    res.status(500).json({ error: "não foi possível gerar o código" });
  }
});

/** LEITURA PURA — não cria sessão, não pede código, não apaga nada. */
function readStatus(req, res) {
  const state = publicState(req.params.ref);
  if (!state) return res.status(404).json({ error: "not found" });
  res.json(state);
}

app.get("/sessions/:ref/status", readStatus);
app.get("/sessions/:ref", readStatus);

/** Retoma uma sessão já registrada que não está viva (após reinício). */
app.post("/sessions/:ref/resume", async (req, res) => {
  const ref = req.params.ref;
  const meta = loadMeta(ref);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (sessions.has(ref)) return res.json(publicState(ref));
  if (!isRegistered(ref)) {
    return res.status(409).json({ error: "sessão não registrada — gere um novo código" });
  }
  try {
    await openSocket(ref, meta, "resume");
    res.json(publicState(ref));
  } catch (e) {
    logger.error({ e, ref }, "resume failed");
    res.status(500).json({ error: "não foi possível retomar a sessão" });
  }
});

app.delete("/sessions/:ref", async (req, res) => {
  const ref = req.params.ref;
  const entry = sessions.get(ref);
  if (entry) {
    entry.stopped = true;
    try {
      await entry.sock.logout();
    } catch {}
    sessions.delete(ref);
  }
  fs.rmSync(sessionDir(ref), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post("/sessions/:ref/messages", async (req, res) => {
  const ref = req.params.ref;
  let entry = sessions.get(ref);
  // Sessão registrada porém adormecida (após reinício): retoma sob demanda.
  if (!entry && isRegistered(ref) && loadMeta(ref)) {
    try {
      await openSocket(ref, loadMeta(ref), "resume");
      for (let i = 0; i < 40 && sessions.get(ref)?.status !== "connected"; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      entry = sessions.get(ref);
    } catch (e) {
      logger.error({ e, ref }, "lazy resume failed");
    }
  }
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
      else
        payload = {
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
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: entry.sock.updateMediaMessage },
    );
    const m = msg.message || {};
    const mimeType =
      m.audioMessage?.mimetype ||
      m.imageMessage?.mimetype ||
      m.videoMessage?.mimetype ||
      m.documentMessage?.mimetype ||
      "application/octet-stream";
    res.json({
      base64: buffer.toString("base64"),
      mimeType,
      filename: m.documentMessage?.fileName || null,
    });
  } catch (e) {
    logger.error({ e }, "media download failed");
    res.status(500).json({ error: "falha ao baixar mídia" });
  }
});

// ------------------------------------------------------------------
// Ao subir: só reconecta o que já estava registrado.
// Tentativas de pareamento incompletas NÃO voltam à vida.
// ------------------------------------------------------------------
for (const ref of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
  const meta = loadMeta(ref);
  if (!meta) continue;
  if (!isRegistered(ref)) {
    saveMeta(ref, { status: "disconnected", pairingCode: null, pairingExpiresAt: null });
    continue;
  }
  openSocket(ref, meta, "resume").catch((e) => logger.error({ e }, `revive ${ref} failed`));
}

app.listen(PORT, () => console.log(`SquadIA WhatsApp bridge v3 on :${PORT}`));
