const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';
const TOKEN_KEY = 'bingo_jwt';

// Stake tiers (§4.5) — must match STAKES in the backend's utils/helpers.js.
export const STAKES = [10, 20, 30, 50];

export function getToken() {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const REQUEST_TIMEOUT_MS = 20000;
const RETRY_STATUSES = new Set([502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() has no timeout, so on a weak connection a request could hang
 * forever (Buy button stuck on "busy", profile never loading). Every request
 * is bounded, and idempotent GETs are retried a couple of times on network
 * errors / timeouts / gateway errors. POSTs are never auto-retried here:
 * the user retries them explicitly (the purchase endpoint is idempotent).
 */
async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        const err = json.error || {};
        throw new ApiError(res.status, err.code || 'UNKNOWN', err.message || 'Something went wrong', err.details);
      }
      return json.data;
    } catch (err) {
      if (err instanceof ApiError) throw err; // a real server answer — don't retry
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const timedOut = lastErr && lastErr.name === 'AbortError';
  throw new ApiError(
    0,
    timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
    timedOut
      ? 'The connection is very slow. Please check your internet and try again.'
      : 'Could not reach the server. Please check your internet and try again.'
  );
}

export const api = {
  loginWithTelegram: (initData) => request('/api/auth/telegram', { method: 'POST', body: { initData }, auth: false }),
  getProfile: () => request('/api/user/profile'),
  updateProfile: (fields) => request('/api/user/profile', { method: 'PUT', body: fields }),
  getBalance: () => request('/api/wallet/balance'),
  getTransactions: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/wallet/transactions${qs ? `?${qs}` : ''}`);
  },
  requestDeposit: (amount, proof, method = 'TELEBIRR') => request('/api/wallet/deposit', { method: 'POST', body: { amount, proof, method } }),
  requestWithdrawal: (amount) => request('/api/wallet/withdraw', { method: 'POST', body: { amount } }),
  getLobby: (stake = 10) => request(`/api/game/lobby?stake=${stake}`),
  getGameState: (gameId) => request(`/api/game/state?gameId=${encodeURIComponent(gameId)}`),
  getGameHistory: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/game/history${qs ? `?${qs}` : ''}`);
  },
  getAvailableCartelas: (gameId) => request(`/api/cartela/available?gameId=${encodeURIComponent(gameId)}`),
  getMyCartelas: (gameId) => request(`/api/cartela/mine?gameId=${encodeURIComponent(gameId)}`),
  purchaseCartelas: (gameId, cartelaIds) => request('/api/cartela/purchase', { method: 'POST', body: { gameId, cartelaIds } }),
  // NEW: Fetch a single cartela by ID
  getCartela: (cartelaId) => request(`/api/cartela/${encodeURIComponent(cartelaId)}`),
  // NEW: Fetch cartela by ID with game context (if needed by backend)
  getCartelaWithGame: (cartelaId, gameId) => request(`/api/cartela/${encodeURIComponent(cartelaId)}?gameId=${encodeURIComponent(gameId)}`)
};

export { ApiError, BACKEND_URL };