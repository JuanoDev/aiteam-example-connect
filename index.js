const functions = require('@google-cloud/functions-framework');
const { google } = require('googleapis');

/* ============ ENV ============ */
const N8N_WEBHOOK_URL  = process.env.N8N_WEBHOOK_URL || '';
const N8N_TIMEOUT_MS   = parseInt(process.env.N8N_TIMEOUT_MS || '60000', 10);
const PLACEHOLDER_TEXT = process.env.PLACEHOLDER_TEXT || '*Escribiendo... 🤖*';
const LOG_LEVEL        = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CALLBACK_URL     = process.env.CALLBACK_URL || '';

const N8N_MAX_RETRIES  = parseInt(process.env.N8N_MAX_RETRIES || '3', 10);
const N8N_RETRY_DELAY  = parseInt(process.env.N8N_RETRY_DELAY || '2000', 10);
const ERROR_FALLBACK_TEXT = process.env.ERROR_FALLBACK_TEXT || 
  '⚠️ Lo siento, hubo un problema al procesar tu mensaje. Por favor, intenta nuevamente.';

/* ============ LOGS ============ */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  const current = LEVELS[LOG_LEVEL] ?? LEVELS.info;
  return lvl >= current;
}

function getTraceId(req) {
  const h = req.headers['x-cloud-trace-context'] || '';
  const [traceId] = h.split('/');
  return traceId || undefined;
}

function log(level, message, meta = {}, ctx = {}) {
  if (!shouldLog(level)) return;
  console.log(JSON.stringify({
    severity: level.toUpperCase(),
    message,
    correlationId: ctx.correlationId,
    path: ctx.path,
    traceId: ctx.traceId,
    ...meta,
  }));
}

function sanitize(obj, maxLen = 2000) {
  try {
    let s = JSON.stringify(obj);
    if (s.length > maxLen) s = s.slice(0, maxLen) + '…[truncated]';
    return s;
  } catch {
    return '[Unserializable]';
  }
}

log('info', 'startup', {
  hasN8nUrl: !!N8N_WEBHOOK_URL,
  hasCallbackUrl: !!CALLBACK_URL,
  n8nTimeoutMs: N8N_TIMEOUT_MS,
  maxRetries: N8N_MAX_RETRIES,
  retryDelayMs: N8N_RETRY_DELAY,
  logLevel: LOG_LEVEL,
}, { path: 'startup' });

/* ============ GOOGLE CHAT CLIENT ============ */
async function getChatClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });
  const client = await auth.getClient();
  google.options({ auth: client });
  return google.chat('v1');
}

/* ============ HELPERS ============ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseChatEvent(body) {
  const chatRoot = body?.chat;
  if (chatRoot?.messagePayload) {
    const payload   = chatRoot.messagePayload || {};
    const msg       = payload.message || {};
    const spaceObj  = msg.space || payload.space || {};
    const threadObj = msg.thread || {};
    const senderObj = msg.sender || chatRoot.user || {};

    const text =
      msg.text ||
      msg.argumentText ||
      payload.argumentText ||
      '';

    const eventType =
      body?.type ||
      body?.eventType ||
      payload?.type ||
      'HTTP_ADDON';

    return {
      eventType,
      space: spaceObj.name || '',
      text,
      threadName: threadObj.name || null,
      userName: senderObj.displayName || 'Usuario',
      userId: senderObj.name || '',
    };
  }

  const msg       = body?.message || {};
  const spaceObj  = msg.space   || body.space   || {};
  const threadObj = msg.thread  || body.thread  || {};
  const senderObj = msg.sender  || body.user    || {};

  const text =
    msg.text ||
    msg.argumentText ||
    body?.argumentText ||
    '';

  const eventType =
    body?.type ||
    body?.eventType ||
    'UNKNOWN';

  return {
    eventType,
    space: spaceObj.name || '',
    text,
    threadName: threadObj.name || null,
    userName: senderObj.displayName || 'Usuario',
    userId: senderObj.name || '',
  };
}

async function createPlaceholder(space, messageId, threadName, ctx) {
  const chat = await getChatClient();
  const body = { text: PLACEHOLDER_TEXT };
  if (threadName) body.thread = { name: threadName };

  log('debug', 'createPlaceholder: request', {
    space,
    messageId,
    hasThread: !!threadName,
  }, ctx);

  await chat.spaces.messages.create({
    parent: space,
    messageId,
    requestBody: body,
  });

  log('info', 'createPlaceholder: ok', { space, messageId }, ctx);
}

async function patchMessage(space, messageId, text, ctx) {
  const chat = await getChatClient();
  const name = `${space}/messages/${messageId}`;

  log('debug', 'patchMessage: request', {
    name,
    updateMask: 'text',
  }, ctx);

  await chat.spaces.messages.patch({
    name,
    updateMask: 'text',
    requestBody: { text },
  });

  log('info', 'patchMessage: ok', {
    space,
    messageId,
    textPreview: (text || '').slice(0, 300),
  }, ctx);
}

/* ⭐ Llamada async a n8n (fire-and-forget) */
async function callN8nAsync({ sessionID, name, action, chatInput, callbackUrl, space, messageId, threadName }, ctx) {
  const fetchFn = global.fetch
    ? global.fetch.bind(global)
    : (await import('node-fetch')).default;

  // ⭐ PAYLOAD CORREGIDO con callback en estructura correcta
  const payload = { 
    sessionID, 
    name, 
    action, 
    chatInput,
    callback: {
      url: callbackUrl,
      space: space,
      messageId: messageId,
    }
  };

  log('info', 'n8n: async request (no wait)', {
    url: N8N_WEBHOOK_URL,
    hasCallback: !!callbackUrl,
  }, ctx);
  
  log('debug', 'n8n: async payload', {
    payloadPreview: sanitize(payload),
  }, ctx);

  try {
    fetchFn(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(e => {
      log('warn', 'n8n: async call failed', { error: e?.message }, ctx);
    });

    log('info', 'n8n: async request sent', {}, ctx);
    return true;
  } catch (e) {
    log('error', 'n8n: async call error', { error: e?.message }, ctx);
    return false;
  }
}

/* ============ ENDPOINTS ============ */

functions.http('chatHandler', async (req, res) => {
  const ctx = {
    path: req.path || '/',
    traceId: getTraceId(req),
  };

  try {
    // Healthcheck
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      log('debug', 'healthcheck', {}, ctx);
      return res.status(200).send('ok');
    }

    // ⭐ ROUTING: distinguir entre mensaje de Chat vs callback de n8n
    const isCallback = req.path === '/callback' || req.body?.isCallback;
    
    if (isCallback) {
      return handleN8nCallback(req, res, ctx);
    }

    if (LOG_LEVEL === 'debug') {
      log('debug', 'chat: raw body', {
        bodyPreview: sanitize(req.body, 4000),
      }, ctx);
    }

    const {
      space,
      text,
      threadName,
      userName,
      userId,
      eventType,
    } = parseChatEvent(req.body || {});

    log('info', 'chat: received', {
      eventType,
      hasSpace: !!space,
      userName,
      hasUserId: !!userId,
      textPreview: (text || '').slice(0, 300),
    }, ctx);

    if (!space) {
      log('warn', 'chat: invalid payload (no space)', {}, ctx);
      return res.status(200).json({});
    }

    const messageId = `client-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ctxCorr = { ...ctx, correlationId: messageId };

    try {
      await createPlaceholder(space, messageId, threadName, ctxCorr);
    } catch (e) {
      log('error', 'createPlaceholder failed', { error: e?.message }, ctxCorr);
    }

    if (!N8N_WEBHOOK_URL) {
      const echo = `Echo (${userName}): ${text || '(vacío)'}`;
      try {
        await patchMessage(space, messageId, echo, ctxCorr);
      } catch (e) {
        log('error', 'patchMessage echo failed', { error: e?.message }, ctxCorr);
      }
      return res.status(200).json({});
    }

    const callbackUrl = CALLBACK_URL 
      ? `${CALLBACK_URL}/callback`
      : null;

    await callN8nAsync({
      sessionID: userId || userName,
      name: userName,
      action: 'send-message',
      chatInput: text,
      callbackUrl,
      space,
      messageId,
      threadName,
    }, ctxCorr);

    log('info', 'chat: responded 200 (processing async)', {}, ctxCorr);
    return res.status(200).json({});

  } catch (e) {
    log('error', 'unhandled error', {
      error: e?.message,
      stack: e?.stack,
    }, ctx);
    return res.status(200).json({});
  }
});

async function handleN8nCallback(req, res, ctx) {
  try {
    log('info', 'callback: received from n8n', {}, ctx);

    const { space, messageId, text, error } = req.body || {};

    if (!space || !messageId) {
      log('warn', 'callback: invalid payload', { hasSpace: !!space, hasMessageId: !!messageId }, ctx);
      return res.status(400).json({ error: 'Missing space or messageId' });
    }

    const ctxCorr = { ...ctx, correlationId: messageId };

    const finalText = error 
      ? ERROR_FALLBACK_TEXT 
      : (text || ERROR_FALLBACK_TEXT);

    try {
      await patchMessage(space, messageId, finalText, ctxCorr);
      log('info', 'callback: message updated', { space, messageId }, ctxCorr);
    } catch (e) {
      log('error', 'callback: patchMessage failed', { error: e?.message }, ctxCorr);
      return res.status(500).json({ error: 'Failed to update message' });
    }

    return res.status(200).json({ success: true });

  } catch (e) {
    log('error', 'callback: unhandled error', {
      error: e?.message,
      stack: e?.stack,
    }, ctx);
    return res.status(500).json({ error: 'Internal error' });
  }
}