import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthService, generateAccessCode } from './auth.js';

const CODE_SECRET = 'code-secret-abcdefghijklmnopqrstuvwxyz-123456';
const SESSION_SECRET = 'session-secret-abcdefghijklmnopqrstuvwxyz-123456';
const TELEGRAM_TOKEN = '123456:test-token';
const TELEGRAM_CHAT = '-1001234567890';

function configuredService(overrides = {}) {
  return createAuthService({
    codeSecret: CODE_SECRET,
    sessionSecret: SESSION_SECRET,
    telegramBotToken: TELEGRAM_TOKEN,
    telegramChatId: TELEGRAM_CHAT,
    cookieSecure: false,
    logger: { warn() {}, error() {} },
    ...overrides
  });
}

test('generateAccessCode is deterministic inside each time window', () => {
  const first = generateAccessCode(CODE_SECRET, 1_800_000, 30, 8);
  const sameWindow = generateAccessCode(CODE_SECRET, 1_829_999, 30, 8);
  const nextWindow = generateAccessCode(CODE_SECRET, 1_830_000, 30, 8);

  assert.match(first, /^\d{8}$/u);
  assert.equal(first, sameWindow);
  assert.notEqual(first, nextWindow);
});

test('login accepts the current code and a short grace period for the previous code', () => {
  let timestamp = 1_830_000;
  const service = configuredService({ now: () => timestamp, graceSeconds: 5 });
  const previousCode = service.currentCode(timestamp - 30_000);
  const currentCode = service.currentCode(timestamp);

  assert.equal(service.verifyLoginCode(currentCode, 'current').ok, true);
  assert.equal(service.verifyLoginCode(previousCode, 'grace').ok, true);

  timestamp += 6_000;
  assert.equal(service.verifyLoginCode(previousCode, 'expired').ok, false);
});

test('login locks repeated invalid attempts by remote address', () => {
  const service = configuredService({ attemptsLimit: 2, lockSeconds: 60 });
  const currentCode = service.currentCode();
  const wrongCode = `${currentCode[0] === '9' ? '8' : '9'}${currentCode.slice(1)}`;

  assert.equal(service.verifyLoginCode(wrongCode, '198.51.100.4').status, 401);
  const locked = service.verifyLoginCode(wrongCode, '198.51.100.4');
  assert.equal(locked.status, 429);
  assert.equal(locked.retryAfter, 60);
});

test('issued sessions are signed, expire and can be cleared', () => {
  let timestamp = 1_800_000;
  const service = configuredService({ now: () => timestamp, sessionHours: 1 });
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };

  service.issueSession(response);
  const cookieHeader = headers.get('Set-Cookie');
  const cookie = cookieHeader.split(';', 1)[0];
  const request = { headers: { cookie } };

  assert.match(cookieHeader, /HttpOnly/u);
  assert.match(cookieHeader, /SameSite=Strict/u);
  assert.equal(service.isAuthenticated(request), true);

  const [name, token] = cookie.split('=');
  const tamperedRequest = {
    headers: { cookie: `${name}=${token.slice(0, -1)}x` }
  };
  assert.equal(service.isAuthenticated(tamperedRequest), false);

  timestamp += 3_600_001;
  assert.equal(service.isAuthenticated(request), false);

  service.clearSession(response);
  assert.match(headers.get('Set-Cookie'), /Max-Age=0/u);
});

test('Telegram publisher sends once and then edits the same group message', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = new URL(url).pathname.split('/').at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    const result = method === 'sendMessage' ? { message_id: 42 } : true;
    return {
      ok: true,
      json: async () => ({ ok: true, result })
    };
  };
  const service = configuredService({
    now: () => 1_800_000,
    fetchImpl
  });

  await service.publishTelegramCode();
  await service.publishTelegramCode();

  assert.deepEqual(calls.map(call => call.method), [
    'sendMessage',
    'pinChatMessage',
    'editMessageText'
  ]);
  assert.equal(calls[0].body.chat_id, TELEGRAM_CHAT);
  assert.equal(calls[2].body.message_id, 42);
  assert.match(calls[0].body.text, /Código de acceso: <code>\d{8}<\/code>/u);
});
