const logger = require('../utils/logger');

let botInstance = null;
let ioInstance = null;

function init({ bot, io }) {
  botInstance = bot;
  ioInstance = io;
}

const TELEGRAM_SEND_TIMEOUT_MS = 10 * 1000;

/** Telegraf has no request timeout of its own; a half-open TCP connection would otherwise hang forever. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Sends a Markdown-formatted Telegram message to a user by their telegramId. */
async function notifyTelegram(telegramId, text) {
  if (!botInstance) return;
  try {
    await withTimeout(
      botInstance.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' }),
      TELEGRAM_SEND_TIMEOUT_MS,
      'Telegram sendMessage'
    );
  } catch (err) {
    logger.warn('Failed to send Telegram notification', { telegramId, error: err.message });
  }
}

/** Broadcasts a Socket.IO event to every client that joined a given game room. */
function emitToGame(gameId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(`game:${gameId}`).emit(event, payload);
}

/** Sends a Socket.IO event to a single user's private room (if connected). */
function emitToUser(userId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(`user:${userId}`).emit(event, payload);
}

module.exports = { init, notifyTelegram, emitToGame, emitToUser };
