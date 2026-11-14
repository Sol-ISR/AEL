require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');

const logger = require('./src/utils/logger');
const { connectDatabase } = require('./src/utils/database');
const { runStartupBootstrap } = require('./src/utils/bootstrap');
const { notFoundHandler, errorHandler } = require('./src/middleware/errorHandler');
const { initSocketServer } = require('./src/sockets');
const { createBot } = require('./src/bot/webhook');
const notificationService = require('./src/services/notificationService');
const walletService = require('./src/services/walletService');
const engine = require('./src/game/engine');
const { Cartela } = require('./src/models');

// A single rejected promise inside a socket/bot handler must never take the
// whole platform down (Node >= 15 terminates the process on an unhandled
// rejection, which on Render means ~1 minute of downtime + a reconnect storm
// from every player). Log it and keep serving. A synchronous uncaught
// exception can leave state undefined, so that one still exits and lets
// Render restart us (crash recovery resumes the in-flight game).
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting so the platform restarts cleanly', { error: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500).unref();
});

let shuttingDown = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUIRED_ENV = ['MONGODB_URI', 'REDIS_URL', 'REDIS_TOKEN', 'BOT_TOKEN', 'JWT_SECRET', 'ADMIN_ID', 'ADMIN_PIN'];

function checkRequiredEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    process.exit(1);
  }
}

async function main() {
  checkRequiredEnv();

  await connectDatabase();
  await runStartupBootstrap();

  const cartelaCount = await Cartela.countDocuments({});
  if (cartelaCount === 0) {
    logger.error(
      '########################################################################\n' +
      '# NO CARTELA TEMPLATES FOUND. The game engine cannot create a playable #\n' +
      '# round without them, and the selection screen will show every cartela #\n' +
      '# as unavailable. Run this once against THIS environment\'s database:  #\n' +
      '#                                                                      #\n' +
      '#     npm run import:cartelas                                         #\n' +
      '#                                                                      #\n' +
      '# The engine will keep retrying every 30s and will pick this up       #\n' +
      '# automatically as soon as the import finishes — no restart needed.   #\n' +
      '########################################################################'
    );
  }

  const app = express();
  // Render terminates TLS at its proxy. Without this, req.ip is the proxy's
  // address for EVERY request, so the per-IP rate limiter on the pre-auth
  // endpoints (/api/auth/telegram: 180 per 5 min) was one shared bucket for
  // the entire player base — a burst of players opening the mini-app at once
  // (or retrying on a bad connection) locked everyone else out with 429.
  app.set('trust proxy', 1);
  app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

  const bot = createBot();

  // Telegram webhook endpoint. In production, set this via scripts/setWebhook.js.
  app.use(bot.webhookCallback('/api/webhook'));
  // JSON body parsing for everything EXCEPT the webhook route above, which
  // Telegraf's own middleware already parses.
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.use('/api/auth', require('./src/api/auth'));
  app.use('/api/user', require('./src/api/user'));
  app.use('/api/wallet', require('./src/api/wallet'));
  app.use('/api/game', require('./src/api/game'));
  app.use('/api/cartela', require('./src/api/cartela'));
  app.use('/api/admin', require('./src/api/admin'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  const httpServer = http.createServer(app);
  // Node's default keep-alive timeout (5s) is shorter than the load balancer's
  // idle timeout, so the LB sometimes reuses a connection Node has just closed
  // -> sporadic 502 / "failed to fetch" on perfectly healthy requests.
  httpServer.keepAliveTimeout = 120 * 1000;
  httpServer.headersTimeout = 125 * 1000;
  const io = initSocketServer(httpServer);

  notificationService.init({ bot, io });

  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    logger.info(`Backend listening on port ${PORT}`);
  });

  // Periodic maintenance: auto-release withdrawals stuck past the hold
  // timeout (§4.4/§12). Runs independently of the game loop.
  setInterval(() => {
    walletService.autoReleaseStaleWithdrawals().catch((err) => {
      logger.error('autoReleaseStaleWithdrawals failed', { error: err.message });
    });
  }, 15 * 60 * 1000);

  // The continuous game engine (§0.4/§6.3) — runs forever, recovering from
  // crashes on this call itself since recoverOnBoot() is the first thing it does.
  const engineDone = engine
    .start()
    .then(() => {
      // start() only resolves when the loops have stopped. If that was NOT an
      // orderly shutdown (e.g. the engine lease was lost), the HTTP server
      // would otherwise keep running with no game loop at all — the "bot is
      // up but nothing ever happens" failure. Exit so Render restarts us and
      // crash recovery resumes the in-flight round.
      if (!shuttingDown) {
        logger.error('Game engine stopped unexpectedly — exiting for a clean restart', { lockLost: engine.wasLockLost() });
        process.exit(1);
      }
    })
    .catch((err) => {
      logger.error('Game engine crashed unexpectedly', { error: err.message, stack: err.stack });
      process.exit(1);
    });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down gracefully`);
    engine.stop();
    // Disconnect websocket clients first. Open sockets keep httpServer.close()
    // from ever finishing, which used to force the 10s fallback exit on every
    // deploy. Clients simply reconnect to the new instance and re-join.
    io.close();
    httpServer.close();
    // Wait (bounded) for the engine loops to wind down: start()'s `finally`
    // releases the engine lock, so the incoming instance can take over
    // immediately instead of waiting for the lease to expire.
    await Promise.race([engineDone.catch(() => {}), sleep(8000)]);
    // Exit 0: a deliberate shutdown is not a failure, and exit code 1 is what
    // makes Render send a "server failure" alert on every deploy.
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
