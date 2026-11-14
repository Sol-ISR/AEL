'use client';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getToken } from '../lib/api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

/**
 * Opens one authenticated Socket.IO connection per mounted tree and exposes
 * it plus a connected flag. The JWT is passed via the handshake auth object
 * (§10.1) — never as a query param, so it never ends up in a server log line.
 */
export function useWebSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const token = getToken();
    if (!token) return undefined;

    const socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      // Unstable networks: reconnect quickly at first, back off with jitter,
      // never give up (default is fine) and allow a slow handshake.
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20000
    });
    socketRef.current = socket;
    forceRender((n) => n + 1);

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { socket: socketRef.current, connected };
}
