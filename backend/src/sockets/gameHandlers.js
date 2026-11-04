const { Game } = require('../models');
const cartelaService = require('../services/cartelaService');
const { getDrawnNumbers } = require('../game/drawnNumbers');
const logger = require('../utils/logger');

/**
 * Socket handlers run outside Express, so nothing catches a rejected promise
 * for them. On Node >= 15 an unhandled rejection kills the whole process —
 * one Mongo timeout in join_game (likelier the more players are connected)
 * restarted the entire platform. Every handler is therefore wrapped, and
 * every payload is treated as untrusted (a flaky client can send null).
 */
function safe(name, fn) {
  return async function wrapped(...args) {
    try {
      await fn(...args);
    } catch (err) {
      logger.warn(`Socket handler "${name}" failed`, { error: err.message });
    }
  };
}

function asGameId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

async function sendFullState(socket, gameId) {
  const game = await Game.findOne({ gameId });
  if (!game) return;
  const [{ real, admin, total }, calledNumbers] = await Promise.all([
    cartelaService.countSold(gameId),
    getDrawnNumbers(game)
  ]);
  socket.emit('game_state_update', {
    gameId: game.gameId,
    status: game.status,
    stake: game.stake,
    playersCount: real,
    totalCartelas: total,
    adminCartelas: admin,
    currentDrawIndex: game.currentDrawIndex,
    prizePool: game.prizePool ?? null,
    grossPrizePool: game.grossPrizePool ?? 0,
    // Full list of numbers called so far: a player who (re)connects mid-round
    // — very common on unstable mobile data — would otherwise never learn the
    // numbers they missed, since number_drawn is only ever pushed once.
    calledNumbers
  });
}

function registerGameHandlers(io, socket) {
  socket.on('join_game', safe('join_game', async (payload) => {
    const gameId = asGameId(payload && payload.gameId);
    if (!gameId) return;
    socket.join(`game:${gameId}`);
    socket.currentGameId = gameId;
    logger.debug('Socket joined game room', { userId: socket.userId, gameId });
    await sendFullState(socket, gameId);
  }));

  socket.on('leave_game', (payload) => {
    const gameId = asGameId(payload && payload.gameId);
    if (gameId) socket.leave(`game:${gameId}`);
    socket.currentGameId = null;
  });

  // Lightweight presence signal only — the real, money-moving purchase goes
  // through POST /api/cartela/purchase (§8.6), which itself broadcasts the
  // persisted cartela_update once the atomic purchase succeeds. This event
  // just lets other players see "someone is looking at this cartela" live.
  socket.on('select_cartela', (payload) => {
    const gameId = asGameId(payload && payload.gameId);
    const cartelaId = payload && payload.cartelaId;
    if (!gameId || !cartelaId) return;
    socket.to(`game:${gameId}`).emit('cartela_update', {
      gameId,
      cartelaId,
      status: 'previewing',
      ownerId: null
    });
  });

  // Auto-daubing is purely a client-side animation preference — the server
  // already marks every cartela automatically regardless (§4.7 Step 3) and
  // winner detection never requires a manual claim (§6.6). Just ack it.
  socket.on('toggle_auto_mode', (payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, autoMode: !!(payload && payload.enabled) });
  });

  socket.on('refresh_state', safe('refresh_state', async (payload) => {
    const gameId = asGameId(payload && payload.gameId) || socket.currentGameId;
    if (gameId) await sendFullState(socket, gameId);
  }));
}

module.exports = registerGameHandlers;
