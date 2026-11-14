const mongoose = require('mongoose');
const { Game, GameCartela, Transaction, User, HouseWallet, DrawSequence } = require('../models');
const stateMachine = require('./stateMachine');
const scheduler = require('./scheduler');
const winnerDetection = require('./winnerDetection');
const cartelaService = require('../services/cartelaService');
const walletService = require('../services/walletService');
const houseAllocationService = require('../services/houseAllocationService');
const notificationService = require('../services/notificationService');
const engineLock = require('./engineLock');
const { HOUSE_TELEGRAM_ID } = require('../utils/bootstrap');
const { STAKES } = require('../utils/helpers');
const logger = require('../utils/logger');

const SELECTION_TIME = scheduler.SELECTION_TIME;
const TICK_INTERVAL = scheduler.TICK_INTERVAL;
const DRAW_INTERVAL = Number(process.env.DRAW_INTERVAL || 3) * 1000;
const COMPLETED_PAUSE = 4000;

let running = false;
let stopRequested = false;
let paused = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Admin-triggered pause: the current round finishes normally, then the loop parks in WAITING without starting a new selection window until resumed (§8.6 game/stop). */
function pause() {
  paused = true;
}
function resume() {
  paused = false;
}
function isPaused() {
  return paused;
}
async function waitWhilePaused() {
  while (paused && !stopRequested) {
    await sleep(1000);
  }
}

/** Broadcasts the shape the frontend expects for game_state_update (§2.3). */
async function broadcastGameState(game, extra = {}) {
  const { real, admin, total } = await cartelaService.countSold(game.gameId);
  notificationService.emitToGame(game.gameId, 'game_state_update', {
    gameId: game.gameId,
    status: game.status,
    stake: game.stake,
    playersCount: total, // real + house-allocated
    totalCartelas: total,
    adminCartelas: admin,
    currentDrawIndex: game.currentDrawIndex,
    prizePool: game.prizePool ?? null,
    grossPrizePool: game.grossPrizePool ?? 0,
    ...extra
  });
}

/**
 * Called right after each house purchase batch: tells every open selection
 * screen the exact IDs (greyed out instantly, no HTTP round trip) and pushes
 * the refreshed players / prize-pool numbers.
 */
async function announceHouseBatch(game, cartelaIds) {
  notificationService.emitToGame(game.gameId, 'cartela_update', {
    gameId: game.gameId,
    cartelaIds,
    status: 'sold',
    ownerId: 'system-admin'
  });
  const fresh = await Game.findOne({ gameId: game.gameId });
  if (fresh) await broadcastGameState(fresh);
}

/** Once the house is done: a single safety-net signal to re-fetch availability in case a client missed a batch. */
async function announceHouseComplete(game, cartelaIds) {
  notificationService.emitToGame(game.gameId, 'cartela_update', {
    gameId: game.gameId,
    cartelaIds,
    status: 'bulk-allocated'
  });
}

/** House auto-allocated cartelas in a game (excludes the globally reserved ones, which are always pre-owned). */
async function countHouseAllocated(gameId) {
  return GameCartela.countDocuments({ gameId, ownerId: 'system-admin', isReserved: { $ne: true } });
}

/**
 * WAITING_FOR_PLAYERS (§6.3). Runs the 45s countdown, checking sold counts
 * every 5s. Restarts the window (same game document) if the window closes
 * with 0 real cartelas sold.
 */
async function runWaitingPhase(game) {
  for (;;) {
    game.startTime = new Date();
    game.status = 'WAITING';
    await game.save();
    await broadcastGameState(game);

    const totalTicks = Math.ceil(SELECTION_TIME / TICK_INTERVAL);
    let realSoldEverThisWindow = false;
    let anySoldThisWindow = false; // real OR house auto-allocated — decides whether the game runs

    // House auto-allocation runs alongside the countdown: several small,
    // naturally-spaced purchases starting in the first few seconds and spread
    // over the first 10-20 s. Does nothing unless an admin switched it ON; while
    // ON it pauses only after 3 rounds in a row of this stake ended with 0 real
    // purchases, and while paused it allocates as soon as a real player buys in
    // the round — always before the round goes ACTIVE (see
    // houseAllocationService.runNaturalAllocation).
    const houseCtl = { cancelled: false };
    const housePromise = houseAllocationService.runNaturalAllocation(game, {
      ctl: houseCtl,
      startedAt: Date.now(),
      selectionMs: SELECTION_TIME * 1000,
      onBatch: (ids) => announceHouseBatch(game, ids),
      onComplete: (ids) => announceHouseComplete(game, ids)
    });

    try {
      for (let tick = 0; tick < totalTicks; tick++) {
        if (stopRequested) return { aborted: true };
        await sleep(TICK_INTERVAL * 1000);

        const elapsed = (tick + 1) * TICK_INTERVAL;
        const remaining = Math.max(0, SELECTION_TIME - elapsed);
        notificationService.emitToGame(game.gameId, 'countdown_update', { remainingSeconds: remaining });

        const { real } = await cartelaService.countSold(game.gameId);
        if (real >= 1) realSoldEverThisWindow = true;
        if (real >= 1 || (await countHouseAllocated(game.gameId)) >= 1) anySoldThisWindow = true;
      }
    } finally {
      // Stop the house at the end of the round and never leave the window (and
      // start ACTIVE) with a purchase mid-flight.
      houseCtl.cancelled = true;
      await housePromise;
    }

    // A purchase that landed after the last 5 s check still counts.
    if (!realSoldEverThisWindow || !anySoldThisWindow) {
      const { real } = await cartelaService.countSold(game.gameId);
      if (real >= 1) realSoldEverThisWindow = true;
      if (real >= 1 || (await countHouseAllocated(game.gameId)) >= 1) anySoldThisWindow = true;
    }

    // Feeds the house's "3 consecutive rounds with 0 real purchases" pause check.
    await houseAllocationService.recordWindowOutcome(game.stake, realSoldEverThisWindow);

    // The game runs if any cartela was sold — real or house auto-allocated.
    if (anySoldThisWindow) return { aborted: false };

    logger.info('0 cartelas sold (real or auto-allocated) — restarting WAITING countdown', { gameId: game.gameId });
    notificationService.emitToGame(game.gameId, 'game_cycle_update', { newState: 'WAITING', nextState: 'WAITING' });
  }
}

/** Re-checks winners against numbers already drawn (crash-recovery safety net, §12). */
async function checkWinnersSoFar(game, drawSequence) {
  const drawnSoFar = drawSequence.numbers.slice(0, game.currentDrawIndex);
  const cartelas = await cartelaService.getGameCartelasWithGrids(game.gameId);
  return winnerDetection.checkWinners(cartelas, drawnSoFar);
}

/**
 * ACTIVE_GAMEPLAY (§6.3). Draws one number every DRAW_INTERVAL ms, persisting
 * currentDrawIndex after each draw, and checks all cartelas for winners.
 */
async function runActiveGameplayPhase(game) {
  const started = await stateMachine.transitionState(game.gameId, 'WAITING', 'ACTIVE', { startTime: new Date() });
  if (!started) throw new Error(`Failed to transition ${game.gameId} WAITING -> ACTIVE`);
  Object.assign(game, started.toObject());
  notificationService.emitToGame(game.gameId, 'game_cycle_update', { newState: 'ACTIVE', nextState: 'ACTIVE' });
  // §2.3: game_state_update must fire on every status change, not just into
  // WAITING — clients (e.g. the cartela-selection page) key off this event's
  // `status` field to know the round went live and to redirect players who
  // didn't buy a cartela into the live/spectator view in real time.
  await broadcastGameState(game);

  const drawSequence = await DrawSequence.findById(game.drawSequenceId);

  // Crash-recovery safety net: if we're resuming mid-game, re-run winner
  // detection against numbers already drawn before drawing anything new.
  let winners = await checkWinnersSoFar(game, drawSequence);
  if (winners.length > 0) return { winners, noWinner: false };

  while (game.currentDrawIndex < 75) {
    if (stopRequested) return { aborted: true };
    await sleep(DRAW_INTERVAL);

    const number = drawSequence.numbers[game.currentDrawIndex];
    game.currentDrawIndex += 1;
    await game.save();

    const letter = ['B', 'I', 'N', 'G', 'O'][Math.floor((number - 1) / 15)];
    notificationService.emitToGame(game.gameId, 'number_drawn', { number, letter, timestamp: Date.now() });

    const cartelas = await cartelaService.getGameCartelasWithGrids(game.gameId);
    winners = winnerDetection.checkWinners(cartelas, drawSequence.numbers.slice(0, game.currentDrawIndex));
    if (winners.length > 0) return { winners, noWinner: false };
  }

  return { winners: [], noWinner: true };
}

/**
 * SETTLING (§6.3/§6.6/§7.5). Locks the game (already ACTIVE -> SETTLING is
 * itself the lock), computes prize distribution, generates every
 * transaction atomically, updates balances, then transitions to COMPLETED.
 * Safe to re-run: it's re-derived entirely from committed state, and the
 * heavy lifting runs inside a single Mongo session transaction, so a crash
 * mid-settlement leaves nothing partially applied to retry against.
 */
async function settleGame(gameId, winners, noWinner) {
  const settling = await stateMachine.transitionState(gameId, 'ACTIVE', 'SETTLING', { endTime: new Date() });
  if (!settling) throw new Error(`Failed to transition ${gameId} ACTIVE -> SETTLING`);

  const HOUSE_COMMISSION_RATE = Number(process.env.HOUSE_COMMISSION || 0.2);
  const session = await mongoose.startSession();
  let finalGame;

  try {
    await session.withTransaction(async () => {
      const game = await Game.findOne({ gameId }).session(session);
      const houseUser = await User.findOne({ telegramId: HOUSE_TELEGRAM_ID }).session(session);
      const house = await HouseWallet.findOne({ walletId: 'house' }).session(session);

      const grossPrizePool = game.grossPrizePool || 0;

      if (noWinner) {
        // §12 "No Winner": roll the pool to the next game, no payouts.
        await Transaction.create(
          [{
            userId: houseUser._id,
            type: 'ROLLOVER',
            amount: grossPrizePool,
            referenceId: await walletService.nextReferenceId(session),
            gameId,
            status: 'COMPLETED',
            description: 'No winner — prize pool rolled over to next game'
          }],
          { session }
        );
        game.noWinner = true;
        game.prizePool = 0;
        game.houseCommission = 0;
        game.status = 'COMPLETED';
        await game.save({ session });
        finalGame = game;
        return;
      }

      // Whole-Birr rule: no balance in this system ever carries a fraction
      // of a Birr, so every step here rounds to a whole Birr rather than
      // to cents. Any leftover from the per-winner division still goes to
      // the house as HOUSE_FRACTIONAL, exactly as before — it's just now a
      // whole-Birr leftover instead of a sub-Birr one.
      const commission = Math.round(grossPrizePool * HOUSE_COMMISSION_RATE);
      const netPrizePool = grossPrizePool - commission;
      const perWinner = Math.floor(netPrizePool / winners.length);
      const remainder = netPrizePool - perWinner * winners.length;

      // House commission — real house earning, taken from this round's escrow.
      if (commission > 0) {
        await Transaction.create(
          [{
            userId: houseUser._id,
            type: 'HOUSE_COMMISSION',
            amount: commission,
            referenceId: await walletService.nextReferenceId(session),
            gameId,
            status: 'COMPLETED',
            description: `20% house commission for game ${gameId}`
          }],
          { session }
        );
        house.balance += commission;
      }

      // Rounding remainder — real house earning (§6.5/§7.5).
      if (remainder > 0) {
        await Transaction.create(
          [{
            userId: houseUser._id,
            type: 'HOUSE_FRACTIONAL',
            amount: remainder,
            referenceId: await walletService.nextReferenceId(session),
            gameId,
            status: 'COMPLETED',
            description: `Rounding remainder for game ${gameId}`
          }],
          { session }
        );
        house.balance += remainder;
      }

      const winnerRecords = [];
      for (const winner of winners) {
        if (winner.ownerId === 'system-admin') {
          await Transaction.create(
            [{
              userId: houseUser._id,
              type: 'HOUSE_WINNING',
              amount: perWinner,
              referenceId: await walletService.nextReferenceId(session),
              gameId,
              cartelaIds: [winner.cartelaId],
              status: 'COMPLETED',
              description: `Admin cartela #${winner.cartelaId} won — retained by house`
            }],
            { session }
          );
          house.balance += perWinner;
        } else {
          await Transaction.create(
            [{
              userId: winner.ownerId,
              type: 'WINNING',
              amount: perWinner,
              referenceId: await walletService.nextReferenceId(session),
              gameId,
              cartelaIds: [winner.cartelaId],
              status: 'COMPLETED',
              description: `Won game ${gameId} with cartela #${winner.cartelaId}`
            }],
            { session }
          );
          await User.updateOne({ _id: winner.ownerId }, {
            $inc: { mainWalletBalance: perWinner, totalWins: 1, totalWinnings: perWinner }
          }).session(session);
        }

        await GameCartela.updateOne(
          { gameId, cartelaId: winner.cartelaId },
          { $set: { isWinner: true } }
        ).session(session);

        // displayName is fetched here and stored directly on the persisted
        // record — game.winners (what getGameState returns, and what the
        // frontend winner page polls) previously only carried ownerId, so
        // every player besides yourself always showed the 'Player' fallback.
        // notifyWinners()'s socket payload attached displayName separately,
        // but that's a one-shot push, not what the winner page reads from.
        let winnerDisplayName = null;
        if (winner.ownerId !== 'system-admin') {
          const winnerUser = await User.findById(winner.ownerId).session(session);
          winnerDisplayName = winnerUser?.displayName || null;
        } else {
          // House (auto-allocated) cartela: show a randomly picked name from
          // the data/house_names list instead of a generic label, never the
          // same name twice within one game.
          winnerDisplayName = houseAllocationService.nextHouseName({
            exclude: winnerRecords.filter((r) => r.ownerId === 'system-admin').map((r) => r.displayName)
          });
        }

        winnerRecords.push({
          ownerId: winner.ownerId,
          cartelaId: winner.cartelaId,
          prizeAmount: perWinner,
          pattern: winner.patterns,
          displayName: winnerDisplayName
        });
      }

      await house.save({ session });

      game.winners = winnerRecords;
      game.prizePool = netPrizePool;
      game.houseCommission = commission;
      game.status = 'COMPLETED';
      await game.save({ session });
      finalGame = game;
    });
  } finally {
    session.endSession();
  }

  return finalGame;
}

async function notifyWinners(game) {
  if (game.noWinner) {
    notificationService.emitToGame(game.gameId, 'winner_announcement', { winners: [], noWinner: true, prize: 0 });
    return;
  }
  const realWinners = game.winners.filter((w) => w.ownerId !== 'system-admin');
  const users = await User.find({ _id: { $in: realWinners.map((w) => w.ownerId) } });
  const userById = new Map(users.map((u) => [u._id.toString(), u]));

  notificationService.emitToGame(game.gameId, 'winner_announcement', {
    winners: game.winners.map((w) => ({
      cartelaId: w.cartelaId,
      prize: w.prizeAmount,
      pattern: w.pattern,
      displayName: w.ownerId === 'system-admin' ? w.displayName || null : userById.get(String(w.ownerId))?.displayName || null
    })),
    prize: game.winners[0]?.prizeAmount || 0,
    cartelas: game.winners.map((w) => w.cartelaId)
  });

  for (const w of realWinners) {
    const user = userById.get(String(w.ownerId));
    if (!user) continue;
    await notificationService.notifyTelegram(
      user.telegramId,
      `🎉 *BINGO!*\nYour cartela #${w.cartelaId} won!\n🏆 *You received:* ${w.prizeAmount} Birr\n💰 *New balance:* ${user.mainWalletBalance} Birr`
    );
  }
}

/** One full lifecycle pass for a given stake tier: WAITING -> ACTIVE -> SETTLING -> COMPLETED. */
async function runOneGame(stake, rolloverFromGameId = null) {
  const game = await stateMachine.createNewGame(stake, rolloverFromGameId);
  const waitResult = await runWaitingPhase(game);
  if (waitResult.aborted) return;

  const fresh = await Game.findOne({ gameId: game.gameId });
  const { winners, noWinner, aborted } = await runActiveGameplayPhase(fresh);
  if (aborted) return;

  const settled = await settleGame(game.gameId, winners, noWinner);
  await broadcastGameState(settled);
  await notifyWinners(settled);

  await sleep(COMPLETED_PAUSE);

  return { noWinner, settledGameId: settled.gameId };
}

/**
 * Crash recovery (§12): on boot, resume any game left mid-flight for this
 * stake tier rather than starting fresh and orphaning it. Each stake tier
 * (§4.5) runs its own independent game, so recovery is scoped per stake.
 */
async function recoverOnBootForStake(stake) {
  const inFlight = await Game.findOne({ stake, status: { $in: ['WAITING', 'ACTIVE', 'SETTLING'] } }).sort({ startTime: -1 });
  if (!inFlight) {
    logger.info('No in-flight game found on boot for stake — starting fresh', { stake });
    return null;
  }

  logger.info('Resuming in-flight game after restart', { gameId: inFlight.gameId, stake, status: inFlight.status });

  if (inFlight.status === 'SETTLING') {
    // Settlement either fully committed (status would already be COMPLETED,
    // so we wouldn't be here) or didn't start — safe to re-run from scratch.
    const cartelas = await cartelaService.getGameCartelasWithGrids(inFlight.gameId);
    const drawSequence = await DrawSequence.findById(inFlight.drawSequenceId);
    const drawnSoFar = drawSequence.numbers.slice(0, inFlight.currentDrawIndex);
    const winners = winnerDetection.checkWinners(cartelas, drawnSoFar);
    const settled = await settleGame(inFlight.gameId, winners, winners.length === 0);
    await broadcastGameState(settled);
    await notifyWinners(settled);
    return { settledGameId: settled.gameId, noWinner: settled.noWinner };
  }

  if (inFlight.status === 'ACTIVE') {
    const { winners, noWinner, aborted } = await runActiveGameplayPhase(inFlight);
    if (aborted) return null;
    const settled = await settleGame(inFlight.gameId, winners, noWinner);
    await broadcastGameState(settled);
    await notifyWinners(settled);
    await sleep(COMPLETED_PAUSE);
    return { settledGameId: settled.gameId, noWinner };
  }

  // WAITING — simplest and safest is to restart its countdown cleanly.
  const waitResult = await runWaitingPhase(inFlight);
  if (waitResult.aborted) return null;
  const fresh = await Game.findOne({ gameId: inFlight.gameId });
  const { winners, noWinner, aborted } = await runActiveGameplayPhase(fresh);
  if (aborted) return null;
  const settled = await settleGame(inFlight.gameId, winners, noWinner);
  await broadcastGameState(settled);
  await notifyWinners(settled);
  await sleep(COMPLETED_PAUSE);
  return { settledGameId: settled.gameId, noWinner };
}

/**
 * Runs the continuous WAITING -> ACTIVE -> SETTLING -> COMPLETED cycle for
 * one stake tier, forever, until stop() is called. Each stake tier's loop
 * is fully independent — its own current game, its own rollover chain —
 * they just happen to run concurrently within the same process.
 */
async function runStakeLoop(stake) {
  let rolloverFromGameId = null;
  try {
    const recovered = await recoverOnBootForStake(stake);
    if (recovered && recovered.noWinner) rolloverFromGameId = recovered.settledGameId || null;
  } catch (err) {
    logger.error('Crash recovery failed — starting a fresh game instead', { stake, error: err.message, stack: err.stack });
  }

  while (!stopRequested) {
    try {
      await waitWhilePaused();
      if (stopRequested) break;
      const result = await runOneGame(stake, rolloverFromGameId);
      rolloverFromGameId = result && result.noWinner ? result.settledGameId : null;
    } catch (err) {
      logger.error('Game loop iteration failed — retrying with a fresh game after a short pause', {
        stake,
        error: err.message,
        stack: err.stack
      });
      await sleep(5000);
      rolloverFromGameId = null;
    }
  }
}

/**
 * Starts one continuous engine loop per stake tier (§4.5), running
 * concurrently. Never resolves until stop() is called and every tier's
 * loop has wound down.
 *
 * Gated on a distributed lock (§12 addendum, see engineLock.js): Render's
 * zero-downtime deploys run the outgoing and incoming instance side by side
 * for up to ~60s, and both instances call start() independently on boot.
 * Without this gate, both would drive the same in-flight game documents at
 * once, producing "State transition precondition failed (concurrent
 * writer?)" errors and potentially duplicate concurrent games per stake.
 * Only the lock holder runs the stake loops; everyone else waits and
 * retries until the current holder's lease lapses (it exited, or its
 * SIGTERM shutdown finished) or is force-stopped locally.
 */
async function start() {
  if (running) return;
  running = true;
  stopRequested = false;

  const holderId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let renewTimer = null;

  try {
    logger.info('Game engine waiting for lock', { holderId, stakes: STAKES });

    while (!stopRequested) {
      const acquired = await engineLock.tryAcquire(holderId);
      if (acquired) break;
      await sleep(engineLock.ACQUIRE_RETRY_MS);
    }
    if (stopRequested) return;

    logger.info('Engine lock acquired — starting stake loops', { holderId, stakes: STAKES });

    renewTimer = setInterval(async () => {
      const stillHeld = await engineLock.renew(holderId).catch((err) => {
        logger.error('Engine lock renewal errored', { holderId, error: err.message });
        return false;
      });
      if (!stillHeld) {
        logger.error('Lost engine lock — stopping loops immediately to avoid a split-brain writer', { holderId });
        stopRequested = true;
      }
    }, engineLock.RENEW_MS);

    await Promise.all(STAKES.map((stake) => runStakeLoop(stake)));
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    await engineLock.release(holderId).catch((err) => {
      logger.error('Failed to release engine lock on shutdown', { holderId, error: err.message });
    });
    running = false;
  }
}

function stop() {
  stopRequested = true;
}

module.exports = { start, stop, pause, resume, isPaused, settleGame };
