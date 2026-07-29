import crypto from 'node:crypto';

const DEFAULT_COOKIE_NAME = '__Host-homelab_session';

export function createAuthService(options = {}) {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const enabled = options.enabled ?? parseBoolean(process.env.AUTH_ENABLED, true);
  const codeSecret = options.codeSecret ?? process.env.AUTH_CODE_SECRET ?? '';
  const sessionSecret = options.sessionSecret ?? process.env.AUTH_SESSION_SECRET ?? '';
  const telegramBotToken = options.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
  const telegramChatId = options.telegramChatId ?? process.env.TELEGRAM_CHAT_ID ?? '';
  const codeDigits = integerOption(options.codeDigits ?? process.env.AUTH_CODE_DIGITS, 8, 6, 9);
  const periodSeconds = integerOption(
    options.periodSeconds ?? process.env.AUTH_CODE_PERIOD_SECONDS,
    30,
    15,
    300
  );
  const graceSeconds = integerOption(
    options.graceSeconds ?? process.env.AUTH_CODE_GRACE_SECONDS,
    5,
    0,
    Math.min(15, periodSeconds - 1)
  );
  const sessionHours = integerOption(
    options.sessionHours ?? process.env.AUTH_SESSION_HOURS,
    12,
    1,
    720
  );
  const cookieSecure = options.cookieSecure
    ?? parseBoolean(process.env.AUTH_COOKIE_SECURE, true);
  const cookieName = options.cookieName
    ?? (cookieSecure ? DEFAULT_COOKIE_NAME : 'homelab_session');
  const timeZone = options.timeZone ?? process.env.AUTH_TIME_ZONE ?? 'Europe/Madrid';
  const attemptsLimit = integerOption(
    options.attemptsLimit ?? process.env.AUTH_ATTEMPTS_LIMIT,
    6,
    1,
    100
  );
  const attemptsWindowSeconds = integerOption(
    options.attemptsWindowSeconds ?? process.env.AUTH_ATTEMPTS_WINDOW_SECONDS,
    600,
    30,
    86400
  );
  const lockSeconds = integerOption(
    options.lockSeconds ?? process.env.AUTH_LOCK_SECONDS,
    600,
    30,
    86400
  );
  const attempts = new Map();
  const configurationIssues = enabled
    ? [
        [codeSecret.length < 32, 'AUTH_CODE_SECRET debe tener al menos 32 caracteres'],
        [sessionSecret.length < 32, 'AUTH_SESSION_SECRET debe tener al menos 32 caracteres'],
        [telegramBotToken.length === 0, 'Falta TELEGRAM_BOT_TOKEN'],
        [telegramChatId.length === 0, 'Falta TELEGRAM_CHAT_ID']
      ].filter(([invalid]) => invalid).map(([, message]) => message)
    : [];

  let telegramMessageId = null;
  let publisherTimer = null;
  let publisherStopped = true;
  let lastTelegramSuccessAt = 0;

  function isConfigured() {
    return configurationIssues.length === 0;
  }

  function currentCode(timestamp = now()) {
    return generateAccessCode(codeSecret, timestamp, periodSeconds, codeDigits);
  }

  function verifyLoginCode(candidate, remoteAddress = 'unknown') {
    if (!enabled) {
      return { ok: true };
    }

    if (!isConfigured()) {
      return { ok: false, status: 503, error: 'El acceso todavía no está configurado.' };
    }

    const key = remoteAddress || 'unknown';
    const timestamp = now();
    const attempt = attempts.get(key);

    if (attempt?.lockedUntil > timestamp) {
      return {
        ok: false,
        status: 429,
        error: 'Demasiados intentos. Espera antes de volver a probar.',
        retryAfter: Math.ceil((attempt.lockedUntil - timestamp) / 1000)
      };
    }

    const normalized = String(candidate ?? '').replace(/\s+/gu, '');
    const validShape = new RegExp(`^\\d{${codeDigits}}$`, 'u').test(normalized);
    const elapsedInPeriod = Math.floor(timestamp / 1000) % periodSeconds;
    const acceptedCodes = [currentCode(timestamp)];

    if (graceSeconds > 0 && elapsedInPeriod < graceSeconds) {
      acceptedCodes.push(currentCode(timestamp - periodSeconds * 1000));
    }

    const valid = validShape && acceptedCodes.some(code => safeStringEqual(normalized, code));
    if (valid) {
      attempts.delete(key);
      return { ok: true };
    }

    const windowMs = attemptsWindowSeconds * 1000;
    const activeAttempt = !attempt || timestamp - attempt.windowStartedAt >= windowMs
      ? { failures: 0, windowStartedAt: timestamp, lockedUntil: 0 }
      : attempt;
    activeAttempt.failures += 1;

    if (activeAttempt.failures >= attemptsLimit) {
      activeAttempt.lockedUntil = timestamp + lockSeconds * 1000;
    }

    attempts.set(key, activeAttempt);
    const remainingAttempts = Math.max(0, attemptsLimit - activeAttempt.failures);

    return activeAttempt.lockedUntil > timestamp
      ? {
          ok: false,
          status: 429,
          error: 'Demasiados intentos. Espera antes de volver a probar.',
          retryAfter: lockSeconds
        }
      : {
          ok: false,
          status: 401,
          error: 'El código no es válido o acaba de caducar.',
          remainingAttempts
        };
  }

  function issueSession(response) {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + sessionHours * 60 * 60;
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      issuedAt,
      expiresAt,
      nonce: crypto.randomBytes(16).toString('base64url')
    })).toString('base64url');
    const signature = sign(payload, sessionSecret);
    const token = `${payload}.${signature}`;

    response.setHeader('Set-Cookie', serializeCookie(cookieName, token, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'Strict',
      path: '/',
      maxAge: sessionHours * 60 * 60
    }));

    return { expiresAt };
  }

  function clearSession(response) {
    response.setHeader('Set-Cookie', serializeCookie(cookieName, '', {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'Strict',
      path: '/',
      maxAge: 0
    }));
  }

  function isAuthenticated(request) {
    if (!enabled) {
      return true;
    }

    if (!isConfigured()) {
      return false;
    }

    const token = parseCookies(request.headers.cookie ?? '')[cookieName];
    if (!token) {
      return false;
    }

    const separatorIndex = token.lastIndexOf('.');
    if (separatorIndex < 1) {
      return false;
    }

    const payload = token.slice(0, separatorIndex);
    const signature = token.slice(separatorIndex + 1);
    if (!safeStringEqual(signature, sign(payload, sessionSecret))) {
      return false;
    }

    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const currentTimestamp = Math.floor(now() / 1000);
      return session.version === 1
        && Number.isInteger(session.issuedAt)
        && Number.isInteger(session.expiresAt)
        && session.issuedAt <= currentTimestamp + 60
        && session.expiresAt > currentTimestamp;
    } catch {
      return false;
    }
  }

  function publicStatus(request) {
    const telegramFresh = lastTelegramSuccessAt > 0
      && now() - lastTelegramSuccessAt < periodSeconds * 3 * 1000;

    return {
      enabled,
      configured: isConfigured(),
      authenticated: isAuthenticated(request),
      codeDigits,
      periodSeconds,
      sessionHours,
      telegramReady: isConfigured() && telegramFresh,
    };
  }

  async function publishTelegramCode() {
    if (!enabled || !isConfigured()) {
      return;
    }

    const timestamp = now();
    const expiry = new Date(
      (Math.floor(timestamp / (periodSeconds * 1000)) + 1) * periodSeconds * 1000
    );
    const expiryText = new Intl.DateTimeFormat('es-ES', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(expiry);
    const text = [
      '🔐 <b>HomeLab Dashboard</b>',
      '',
      `Código de acceso: <code>${currentCode(timestamp)}</code>`,
      '',
      `Válido hasta las ${expiryText}. Se renueva cada ${periodSeconds} segundos.`,
      'No compartas este código fuera de este grupo.'
    ].join('\n');

    try {
      if (telegramMessageId === null) {
        const message = await telegramRequest('sendMessage', {
          chat_id: telegramChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        telegramMessageId = message.message_id;

        try {
          await telegramRequest('pinChatMessage', {
            chat_id: telegramChatId,
            message_id: telegramMessageId,
            disable_notification: true
          });
        } catch {
          logger.warn('El código se publicó, pero el bot no pudo fijar el mensaje de Telegram.');
        }
      } else {
        await telegramRequest('editMessageText', {
          chat_id: telegramChatId,
          message_id: telegramMessageId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }

      lastTelegramSuccessAt = now();
    } catch (error) {
      if (telegramMessageId !== null && /message to edit not found|message_id_invalid/iu.test(error.message)) {
        telegramMessageId = null;
      }

      logger.error(`No se pudo actualizar el código de Telegram: ${safeTelegramError(error)}`);
    }
  }

  async function telegramRequest(method, body) {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${telegramBotToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      }
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.description ?? `Telegram respondió con ${response.status}`);
    }

    return result.result;
  }

  function scheduleNextPublication() {
    if (publisherStopped) {
      return;
    }

    const periodMs = periodSeconds * 1000;
    const delay = periodMs - (now() % periodMs) + 200;
    publisherTimer = setTimeout(async () => {
      await publishTelegramCode();
      scheduleNextPublication();
    }, delay);
  }

  async function startPublisher() {
    if (!enabled || !isConfigured() || !publisherStopped) {
      return;
    }

    publisherStopped = false;
    await publishTelegramCode();
    scheduleNextPublication();
  }

  function stopPublisher() {
    publisherStopped = true;
    if (publisherTimer !== null) {
      clearTimeout(publisherTimer);
      publisherTimer = null;
    }
  }

  return {
    enabled,
    configurationIssues,
    isConfigured,
    isAuthenticated,
    verifyLoginCode,
    issueSession,
    clearSession,
    publicStatus,
    publishTelegramCode,
    startPublisher,
    stopPublisher,
    currentCode
  };
}

export function generateAccessCode(secret, timestamp, periodSeconds = 30, digits = 8) {
  const counter = BigInt(Math.floor(timestamp / 1000 / periodSeconds));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha256', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  ) >>> 0;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').flatMap(part => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 1) {
      return [];
    }

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    try {
      return [[name, decodeURIComponent(value)]];
    } catch {
      return [];
    }
  }));
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path}`);
  parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function integerOption(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function safeTelegramError(error) {
  const message = String(error?.message ?? 'error desconocido');
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/gu, 'bot[oculto]');
}
