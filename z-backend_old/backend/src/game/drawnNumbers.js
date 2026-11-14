const { DrawSequence } = require('../models');

/**
 * Numbers already called for a game, in call order — used to send a late or
 * reconnecting client a full snapshot. Only the slice up to currentDrawIndex
 * is ever returned, so the not-yet-drawn part of the sequence never leaves
 * the server. The (immutable) sequence is cached per game.
 */
const cache = new Map(); // gameId -> number[] (full sequence, server-side only)
const MAX_CACHED = 16;

async function getDrawnNumbers(game) {
  if (!game || !game.drawSequenceId || !game.currentDrawIndex) return [];
  let numbers = cache.get(game.gameId);
  if (!numbers) {
    const seq = await DrawSequence.findById(game.drawSequenceId).lean();
    numbers = seq ? seq.numbers : [];
    cache.set(game.gameId, numbers);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  }
  return numbers.slice(0, game.currentDrawIndex);
}

module.exports = { getDrawnNumbers };
