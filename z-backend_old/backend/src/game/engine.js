const mongoose = require('mongoose');
const { Game, GameCartela, Transaction, User, HouseWallet, DrawSequence } = require('../models');
const stateMachine = require('./stateMachine');
const scheduler = require('./scheduler');
const winnerDetection = require('./winnerDetection');
const cartelaService = require('../services/cartelaService');
const walletService = require('../services/walletService');
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
let lockLost = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a short DB operation a few times before giving up. A single
 * transient Mongo hiccup (pool saturation, brief network blip) in the middle
 * of the live draw loop used to abort the whole round; one quick retry is
 * almost always enough and keeps the draw cadence intact.
 */
async function withRetry(fn, label, attempts = 3, baseDelayMs = 300) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn('Transient failure in game loop — retrying', { label, attempt: i, error: err.message });
      if (i < attempts) await sleep(baseDelayMs * i);
    }
  }
  throw lastErr;
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
    playersCount: real,
    totalCartelas: total,
    adminCartelas: admin,
    currentDrawIndex: game.currentDrawIndex,
    prizePool: game.prizePool ?? null,
    grossPrizePool: game.grossPrizePool ?? 0,
    ...extra
  });
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

    for (let tick = 0; tick < totalTicks; tick++) {
      if (stopRequested) return { aborted: true };
      await sleep(TICK_INTERVAL * 1000);

      const elapsed = (tick + 1) * TICK_INTERVAL;
      const remaining = Math.max(0, SELECTION_TIME - elapsed);
      notificationService.emitToGame(game.gameId, 'countdown_update', { remainingSeconds: remaining });

      const { real } = await cartelaService.countSold(game.gameId);
      if (real >= 1) realSoldEverThisWindow = true;
    }

    if (realSoldEverThisWindow) return { aborted: false };

    logger.info('0 real cartelas sold — restarting WAITING countdown', { gameId: game.gameId });
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
  if (game.status === 'WAITING') {
    const started = await stateMachine.transitionState(game.gameId, 'WAITING', 'ACTIVE', { startTime: new Date() });
    if (!started) throw new Error(`Failed to transition ${game.gameId} WAITING -> ACTIVE`);
    Object.assign(game, started.toObject());
    notificationService.emitToGame(game.gameId, 'game_cycle_update', { newState: 'ACTIVE', nextState: 'ACTIVE' });
  } else if (game.status !== 'ACTIVE') {
    throw new Error(`Cannot run gameplay for ${game.gameId} in status ${game.status}`);
  }
  // else: RESUMING a game that is already ACTIVE (crash recovery / retry after a
  // transient error). This used to unconditionally attempt WAITING -> ACTIVE,
  // which can never succeed for an ACTIVE game — so resuming a live round
  // always failed and the engine abandoned it by starting a brand-new game.

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
    try {
      await withRetry(() => game.save(), 'draw:save');
    } catch (err) {
      game.currentDrawIndex -= 1; // not persisted — keep memory consistent with the DB before bailing out
      throw err;
    }

    const letter = ['B', 'I', 'N', 'G', 'O'][Math.floor((number - 1) / 15)];
    // drawIndex lets a client that dropped off (flaky mobile data) notice it
    // missed a number and ask for a full snapshot instead of silently
    // showing a wrong board for the rest of the round.
    notificationService.emitToGame(game.gameId, 'number_drawn', {
      number,
      letter,
      drawIndex: game.currentDrawIndex,
      timestamp: Date.now()
    });

    const cartelas = await withRetry(() => cartelaService.getGameCartelasWithGrids(game.gameId), 'draw:load-cartelas');
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

      // Reconcile the escrow against what was actually sold. Purchases bump
      // game.grossPrizePool with an atomic $inc right AFTER their own
      // transaction commits (see cartelaService.purchaseCartelas); if that
      // follow-up write ever failed (crash in the gap), the stored value would
      // be short by one stake. Every real cartela sold cost exactly game.stake,
      // so the true gross is rollover + realSold * stake — never pay out less.
      const realSold = await GameCartela.countDocuments({ gameId, ownerId: { $nin: [null, 'system-admin'] } }).session(session);
      let rolloverIn = 0;
      if (game.rolloverFromGameId) {
        const src = await Game.findOne({ gameId: game.rolloverFromGameId }).session(session);
        if (src && src.noWinner) rolloverIn = src.grossPrizePool || 0;
      }
      const derivedGross = rolloverIn + realSold * game.stake;
      if (derivedGross > (game.grossPrizePool || 0)) {
        logger.warn('grossPrizePool was below the sold-cartela total — correcting at settlement', {
          gameId, stored: game.grossPrizePool || 0, derived: derivedGross
        });
        game.grossPrizePool = derivedGross;
      }
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

      const commission = Math.round(grossPrizePool * HOUSE_COMMISSION_RATE * 100) / 100;
      const netPrizePool = grossPrizePool - commission;
      const perWinner = Math.floor((netPrizePool / winners.length) * 100) / 100;
      const remainder = Math.round((netPrizePool - perWinner * winners.length) * 100) / 100;

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
      displayName: w.ownerId === 'system-admin' ? null : userById.get(String(w.ownerId))?.displayName || null
    })),
    prize: game.winners[0]?.prizeAmount || 0,
    cartelas: game.winners.map((w) => w.cartelaId)
  });

  // Telegram DMs are best-effort and must never hold up the game cycle:
  // they go out in small parallel batches, each with its own timeout (see
  // notificationService.notifyTelegram).
  const messages = realWinners
    .map((w) => ({ w, user: userById.get(String(w.ownerId)) }))
    .filter(({ user }) => !!user);
  const BATCH = 10;
  for (let i = 0; i < messages.length; i += BATCH) {
    await Promise.allSettled(
      messages.slice(i, i + BATCH).map(({ w, user }) =>
        notificationService.notifyTelegram(
          user.telegramId,
          `🎉 *BINGO!*\nYour cartela #${w.cartelaId} won!\n🏆 *You received:* ${w.prizeAmount} Birr\n💰 *New balance:* ${user.mainWalletBalance} Birr`
        )
      )
    );
  }
}

/**
 * Everything after settlement is announcement only — the money has already
 * been committed. A failure here must not throw into the stake loop (it used
 * to, which discarded the rollover and could stall the next round), and the
 * Telegram DMs are NOT awaited so a slow/hung Telegram API cannot delay the
 * next game.
 */
async function announceSettlement(settled) {
  try {
    await broadcastGameState(settled);
  } catch (err) {
    logger.warn('broadcastGameState after settlement failed', { gameId: settled.gameId, error: err.message });
  }
  notifyWinners(settled).catch((err) => {
    logger.warn('notifyWinners failed', { gameId: settled.gameId, error: err.message });
  });
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
  await announceSettlement(settled);

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
    await announceSettlement(settled);
    return { settledGameId: settled.gameId, noWinner: settled.noWinner };
  }

  if (inFlight.status === 'ACTIVE') {
    const { winners, noWinner, aborted } = await runActiveGameplayPhase(inFlight);
    if (aborted) return null;
    const settled = await settleGame(inFlight.gameId, winners, noWinner);
    await announceSettlement(settled);
    await sleep(COMPLETED_PAUSE);
    return { settledGameId: settled.gameId, noWinner };
  }

  // WAITING — simplest and safest is to restart its countdown cleanly.
  // If the game doc was created but the process died / errored before its
  // cartela pool finished seeding, nobody could ever buy into it: re-seed
  // (idempotent — duplicate-key errors are ignored).
  await cartelaService.createGameCartelaPool(inFlight.gameId);
  const waitResult = await runWaitingPhase(inFlight);
  if (waitResult.aborted) return null;
  const fresh = await Game.findOne({ gameId: inFlight.gameId });
  const { winners, noWinner, aborted } = await runActiveGameplayPhase(fresh);
  if (aborted) return null;
  const settled = await settleGame(inFlight.gameId, winners, noWinner);
  await announceSettlement(settled);
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
  let consecutiveFailures = 0;

  while (!stopRequested) {
    try {
      await waitWhilePaused();
      if (stopRequested) break;

      // ALWAYS resume an unfinished game before creating a new one — not just
      // on boot. Previously any error thrown mid-round (a Mongo timeout while
      // drawing, a failed settlement, ...) was caught here and the loop simply
      // created a NEW game, leaving the old one stuck in ACTIVE/SETTLING
      // forever: players' stakes stayed in escrow, their screens froze, and
      // crash-recovery never looked at it again because it only resumes the
      // newest in-flight game.
      const recovered = await recoverOnBootForStake(stake);
      if (recovered) {
        rolloverFromGameId = recovered.noWinner ? recovered.settledGameId || null : null;
        consecutiveFailures = 0;
        continue;
      }
      if (stopRequested) break;

      const result = await runOneGame(stake, rolloverFromGameId);
      rolloverFromGameId = result && result.noWinner ? result.settledGameId : null;
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      // NOTE: rolloverFromGameId is intentionally NOT reset here. It is only
      // consumed once a new game has actually been created from it.
      logger.error('Game loop iteration failed — will resume the in-flight game after a short pause', {
        stake,
        consecutiveFailures,
        error: err.message,
        stack: err.stack
      });
      if (consecutiveFailures >= 10) {
        logger.error('CRITICAL: stake loop failing repeatedly — a round may be wedged and needs manual attention', { stake, consecutiveFailures });
      }
      await sleep(Math.min(5000 * consecutiveFailures, 30000));
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
  lockLost = false;

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

    let lastRenewOkAt = Date.now();
    let renewing = false;
    renewTimer = setInterval(async () => {
      if (renewing) return; // don't stack renewals if the DB is slow
      renewing = true;
      try {
        const stillHeld = await engineLock.renew(holderId);
        if (stillHeld) {
          lastRenewOkAt = Date.now();
          return;
        }
        // Definitive answer from the DB: someone else owns the lease now.
        logger.error('Lost engine lock — stopping loops immediately to avoid a split-brain writer', { holderId });
        lockLost = true;
        stopRequested = true;
      } catch (err) {
        // A renewal that THROWS (network blip, pool saturated, Atlas failover)
        // is not the same as losing the lock. It used to be treated as lost,
        // which permanently stopped every game loop on the first hiccup while
        // the HTTP server kept running — i.e. the platform looked alive but no
        // round ever started again. Only give up once the lease could really
        // have lapsed (and another instance could legitimately take over).
        const sinceOk = Date.now() - lastRenewOkAt;
        logger.warn('Engine lock renewal errored — will retry', { holderId, sinceLastOkMs: sinceOk, error: err.message });
        if (sinceOk >= engineLock.LEASE_MS - engineLock.RENEW_MS) {
          logger.error('Engine lock lease may have expired — stopping loops to avoid a split-brain writer', { holderId });
          lockLost = true;
          stopRequested = true;
        }
      } finally {
        renewing = false;
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

/** True if the loops stopped because the lease was lost (not an orderly shutdown). */
function wasLockLost() {
  return lockLost;
}

module.exports = { start, stop, pause, resume, isPaused, settleGame, wasLockLost };
