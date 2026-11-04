const { User } = require('../models');
const logger = require('../utils/logger');

/**
 * User-scoped events (as opposed to game-room-scoped ones in
 * gameHandlers.js). Currently just a balance snapshot on demand — winnings
 * and deposit confirmations are pushed proactively via
 * notificationService.emitToUser from the services that create them.
 */
function registerUserHandlers(io, socket) {
  socket.on('request_balance', async (_payload, ack) => {
    try {
      const user = await User.findById(socket.userId).select('mainWalletBalance coins');
      const balance = user ? { mainWallet: user.mainWalletBalance, coins: user.coins } : null;
      if (typeof ack === 'function') ack(balance);
      else socket.emit('balance_update', balance);
    } catch (err) {
      logger.warn('Socket handler "request_balance" failed', { error: err.message });
      if (typeof ack === 'function') ack(null);
    }
  });
}

module.exports = registerUserHandlers;
