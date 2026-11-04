const mongoose = require('mongoose');
const { Cartela, GameCartela, Game, User, Transaction } = require('../models');
const { ApiError } = require('../middleware/errorHandler');
const walletService = require('./walletService');
const logger = require('../utils/logger');

const MAX_PER_USER = Number(process.env.MAX_CARTELAS_PER_USER || 12);

/**
 * Pre-seeds a GameCartela document for every cartelaId (1-600) the moment a
 * game is created (§6.4/§10.4). This is what makes the atomic
 * findOneAndUpdate({gameId, cartelaId, ownerId: null}, ...) allocation
 * pattern work: without a pre-existing document, "not found" and "already
 * taken" would be indistinguishable to the caller.
 *
 * Globally-reserved cartelaIds (Cartela.isReserved) are pre-seeded already
 * claimed by 'system-admin' so they're disabled from the very first render
 * of the selection screen, matching "never available to regular players".
 */
async function createGameCartelaPool(gameId) {
  const allTemplates = await Cartela.find({}, { cartelaId: 1, isReserved: 1 }).lean();
  if (allTemplates.length === 0) {
    throw new Error('No cartela templates found — run `npm run import:cartelas` first.');
  }

  const docs = allTemplates.map((t) => ({
    gameId,
    cartelaId: t.cartelaId,
    ownerId: t.isReserved ? 'system-admin' : null,
    isReserved: !!t.isReserved,
    purchasedAt: t.isReserved ? new Date() : null
  }));

  try {
    await GameCartela.insertMany(docs, { ordered: false });
  } catch (err) {
    // Retrying pool-creation for an already-seeded gameId (crash recovery)
    // hits duplicate-key errors, which are safe to ignore — but a bulk
    // insertMany error doesn't reliably expose a single top-level
    // `err.code` across driver versions, so check every individual write
    // error rather than trusting one field.
    const writeErrors = err.writeErrors || (err.code ? [err] : []);
    const allDuplicates = writeErrors.length > 0 && writeErrors.every((e) => (e.code || (e.err && e.err.code)) === 11000);
    if (!allDuplicates) {
      logger.error('createGameCartelaPool insertMany failed', { gameId, error: err.message });
      throw err;
    }
  }
  return docs.length;
}

async function listAvailableCartelas(gameId) {
  const available = await GameCartela.find({ gameId, ownerId: null }, { cartelaId: 1 }).lean();
  return available.map((d) => d.cartelaId).sort((a, b) => a - b);
}

async function countSold(gameId) {
  const [real, admin] = await Promise.all([
    // NOTE: this must be $nin: [null, 'system-admin'] as ONE operator.
    // { $ne: null, $ne: 'system-admin' } is a JS object literal with a
    // duplicate key — JS silently keeps only the last one, so that query
    // actually ran as { $ne: 'system-admin' }, which counts every
    // *unclaimed* (ownerId: null) cartela as if it were a real sale. That
    // made the engine believe the minimum was already met from the moment
    // each game's pool was seeded, so auto-allocation never fired.
    GameCartela.countDocuments({ gameId, ownerId: { $nin: [null, 'system-admin'] } }),
    GameCartela.countDocuments({ gameId, ownerId: 'system-admin' })
  ]);
  return { real, admin, total: real + admin };
}

// Cartela grids are immutable templates (§9.2), yet they were re-read from
// Mongo (up to ~600 grids) on EVERY draw of EVERY stake tier, plus once per
// player opening the live screen. Cache them in memory; entries missing from
// the cache are fetched on demand, and the whole cache expires periodically
// so a re-import of templates is picked up without a restart.
const GRID_CACHE_TTL_MS = 10 * 60 * 1000;
let gridCache = { at: Date.now(), map: new Map() };

async function getGrids(cartelaIds) {
  if (Date.now() - gridCache.at > GRID_CACHE_TTL_MS) gridCache = { at: Date.now(), map: new Map() };
  const map = gridCache.map;
  const missing = cartelaIds.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const templates = await Cartela.find({ cartelaId: { $in: missing } }, { cartelaId: 1, grid: 1 }).lean();
    for (const t of templates) map.set(t.cartelaId, t.grid);
  }
  return map;
}

/** Joins GameCartela ownership with the immutable grid template, for winner detection. */
async function getGameCartelasWithGrids(gameId) {
  const owned = await GameCartela.find({ gameId, ownerId: { $ne: null } }, { cartelaId: 1, ownerId: 1 }).lean();
  if (owned.length === 0) return [];
  const gridById = await getGrids(owned.map((o) => o.cartelaId));
  return owned.map((o) => ({ cartelaId: o.cartelaId, ownerId: o.ownerId, grid: gridById.get(o.cartelaId) }));
}

/**
 * Atomically claims a single cartela for `ownerId` within `gameId`.
 * Returns the updated document, or null if it was already taken.
 */
async function claimCartela(gameId, cartelaId, ownerId, session) {
  return GameCartela.findOneAndUpdate(
    { gameId, cartelaId, ownerId: null },
    { ownerId, purchasedAt: new Date() },
    { new: true, session }
  );
}

/**
 * Real-player purchase (§4.6/§6.4/§7.3). Idempotent: a cartelaId already
 * owned by the SAME requesting user is treated as already-purchased rather
 * than an error, so a client retry after a dropped response doesn't fail.
 */
async function purchaseCartelas(gameId, userId, cartelaIds) {
  const uniqueIds = [...new Set(cartelaIds)];
  if (uniqueIds.length === 0) throw new ApiError(400, 'INVALID_AMOUNT', 'No cartelas selected.');

  const game = await Game.findOne({ gameId });
  if (!game || game.status !== 'WAITING') {
    throw new ApiError(409, 'CARTELA_UNAVAILABLE', 'This game is no longer accepting cartela selections.');
  }

  // Count only cartelas that would be NEWLY acquired. A retry of a purchase
  // that already went through (typical on a flaky connection: the response
  // was lost, the player taps Buy again) must be a harmless no-op, not a
  // "maximum cartelas" error against cartelas the player already owns.
  const ownedByUser = await GameCartela.find({ gameId, ownerId: String(userId) }, { cartelaId: 1 }).lean();
  const ownedSet = new Set(ownedByUser.map((d) => d.cartelaId));
  const newIds = uniqueIds.filter((id) => !ownedSet.has(id));
  if (ownedByUser.length + newIds.length > MAX_PER_USER) {
    throw new ApiError(400, 'INVALID_AMOUNT', `Maximum ${MAX_PER_USER} cartelas per user per game.`);
  }

  // Reserve the ledger reference id BEFORE the transaction. It lives in one
  // shared Counter document; incrementing it inside every purchase
  // transaction made all concurrent buyers write-conflict with each other.
  // A gap in the sequence (if the purchase later aborts) is harmless — the
  // id only needs to be unique — and reusing the same id across driver
  // retries of the transaction is exactly what we want.
  const referenceId = await walletService.nextReferenceId();

  const session = await mongoose.startSession();
  const purchased = [];
  const alreadyOwnedByUser = [];
  let totalCost = 0;

  try {
    await session.withTransaction(async () => {
      // withTransaction re-runs this callback after a transient abort, so the
      // accumulators MUST be reset (they used to grow duplicates on retry).
      purchased.length = 0;
      alreadyOwnedByUser.length = 0;
      totalCost = 0;

      const user = await User.findById(userId).session(session);
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

      const toCharge = [];
      for (const cartelaId of uniqueIds) {
        const claimed = await claimCartela(gameId, cartelaId, String(userId), session);
        if (claimed) {
          toCharge.push(cartelaId);
          purchased.push(cartelaId);
        } else {
          const existing = await GameCartela.findOne({ gameId, cartelaId }).session(session);
          if (existing && existing.ownerId === String(userId)) {
            alreadyOwnedByUser.push(cartelaId); // idempotent no-op
          } else {
            throw new ApiError(409, 'CARTELA_UNAVAILABLE', `Cartela #${cartelaId} is no longer available.`);
          }
        }
      }

      totalCost = toCharge.length * game.stake;
      if (totalCost > 0) {
        if (user.mainWalletBalance < totalCost) {
          throw new ApiError(400, 'INSUFFICIENT_BALANCE', 'Insufficient balance to purchase cartela(s).', {
            required: totalCost,
            available: user.mainWalletBalance
          });
        }
        user.mainWalletBalance -= totalCost;
        await user.save({ session });

        await Transaction.create(
          [{
            userId,
            type: 'GAME_PURCHASE',
            amount: totalCost,
            referenceId,
            gameId,
            cartelaIds: toCharge,
            status: 'COMPLETED',
            description: `Purchased ${toCharge.length} cartela(s) for game ${gameId}`
          }],
          { session }
        );

        // NOTE: grossPrizePool is deliberately NOT incremented in here. Every
        // purchase touching the one Game document inside a transaction made
        // concurrent buyers abort each other (WriteConflict) and retry in a
        // tight loop: with 20-30 players buying in the last seconds of the
        // countdown that is hundreds of wasted transactions that saturate
        // the DB pool and freeze the whole platform. It is applied right
        // after commit with an atomic $inc (below) and re-derived from the
        // sold-cartela count at settlement, so it can never under-count.
      }
    });
  } finally {
    session.endSession();
  }

  if (totalCost > 0) {
    // Atomic single-document $inc (no read-modify-write, no lost updates).
    // Retried briefly; settlement reconciles from the ledger of sold
    // cartelas if this ever fails permanently.
    let applied = false;
    for (let attempt = 1; attempt <= 3 && !applied; attempt++) {
      try {
        await Game.updateOne({ gameId }, { $inc: { grossPrizePool: totalCost } });
        applied = true;
      } catch (err) {
        logger.warn('grossPrizePool increment failed after purchase commit', { gameId, attempt, error: err.message });
        if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }

  const user = await User.findById(userId);
  return {
    purchased: [...purchased, ...alreadyOwnedByUser],
    totalCost,
    newBalance: user.mainWalletBalance
  };
}

/** A single user's owned cartelas (with grids) within a game — powers the live gameplay screen. */
async function getUserCartelas(gameId, userId) {
  const owned = await GameCartela.find({ gameId, ownerId: String(userId) }, { cartelaId: 1, isWinner: 1 }).lean();
  if (owned.length === 0) return [];
  const gridById = await getGrids(owned.map((o) => o.cartelaId));
  return owned.map((o) => ({ cartelaId: o.cartelaId, grid: gridById.get(o.cartelaId), isWinner: o.isWinner }));
}

module.exports = {
  MAX_PER_USER,
  createGameCartelaPool,
  listAvailableCartelas,
  countSold,
  getGameCartelasWithGrids,
  getUserCartelas,
  claimCartela,
  purchaseCartelas
};
