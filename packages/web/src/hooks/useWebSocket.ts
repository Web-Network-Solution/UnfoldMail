/**
 * WebSocket hook — connects to the per-user Durable Object hub.
 *
 * Reconnects with capped exponential backoff, and every timer and socket is
 * tracked so unmounting or logging out actually stops it. The previous version
 * left an untracked `setTimeout(connect, delay)` running after unmount, so a
 * logged-out tab kept dialling and each attempt leaked another heartbeat.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_MAX_RECONNECT_DELAY_MS,
  WS_RECONNECT_DELAY_MS,
} from '@email-service/shared';
import type { WsEvent, WsNewEmailEvent } from '@email-service/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore, useToastStore, useRealtimeStore } from '../stores';
import { API_BASE, ApiError, authApi, identity, signOutIfUnchanged } from '../lib/api';

function websocketUrl(): string {
  // Derived from API_BASE, not window.location, so a split-origin deployment
  // reaches the Worker rather than the static host.
  const base = new URL(API_BASE, window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/ws`;
  return base.toString();
}

export function useWebSocket(userId: string | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const activeRef = useRef(false);

  const addToast = useToastStore((s) => s.addToast);
  const queryClient = useQueryClient();

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!userId || !activeRef.current) return;

    // Never stack sockets: an in-flight or open connection is closed first.
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close(1000, 'Reconnecting');
      socketRef.current = null;
    }

    const ws = new WebSocket(websocketUrl());
    socketRef.current = ws;

    ws.onopen = () => {
      useRealtimeStore.getState().setConnected(true);
      for (const key of ['emails', 'threads', 'thread', 'email', 'folders', 'ai-turns', 'ai-status']) queryClient.invalidateQueries({ queryKey: [key] });
      attemptsRef.current = 0;
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, WS_HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsEvent;
        if(data.type==='ai_updated'){void queryClient.invalidateQueries({queryKey:['ai-turns',userId]});return;}
        if (data.type === 'delivery_updated') {
          for (const key of ['emails', 'threads', 'thread', 'email', 'folders', 'ai-turns', 'ai-status']) queryClient.invalidateQueries({ queryKey: [key] });
          return;
        }
        if (data.type !== 'new_email') return;

        const { sender, senderName, subject, snippet } = (data as WsNewEmailEvent).payload;

        addToast({
          type: 'new_email',
          title: senderName || sender,
          body: subject || snippet,
          duration: 6000,
        });

        // Refresh the lists the new message affects.
        queryClient.invalidateQueries({ queryKey: ['emails'] });
        queryClient.invalidateQueries({ queryKey: ['threads'] });
        queryClient.invalidateQueries({ queryKey: ['thread'] });
        queryClient.invalidateQueries({ queryKey: ['folders'] });
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = (event) => {
      useRealtimeStore.getState().setConnected(false);
      // 4001: the server revoked a session. One probe, not a refetch of every
      // query: Switch Back also sends 4001, and a burst of 401s from the old
      // session landing after the new one is in place signed the admin out.
      // A 200 for someone else means another tab switched back or signed in
      // as another user: reload so user and the impersonation flag match the
      // cookie. Not in the tab whose own Switch Back already changed identity.
      // 4002: this browser moved to another session (Switch Back, possibly in
      // another tab). Probe once the new cookie has had time to land, and never
      // sign out on it; the normal reconnect below picks up the new session.
      const code = event?.code;
      if (code === 4001 || code === 4002) {
        const who = identity();
        const probe = () => authApi.me()
          .then(res => { if (identity() === who && res.data && res.data.id !== useAuthStore.getState().user?.id) window.location.reload(); })
          .catch(error => { if (code === 4001 && error instanceof ApiError && error.status === 401) signOutIfUnchanged(who); });
        if (code === 4001) probe(); else setTimeout(probe, 1500);
      }
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (!activeRef.current) return;

      if (attemptsRef.current < WS_MAX_RECONNECT_ATTEMPTS) {
        // Capped, so the delay cannot grow to ~25 minutes as it did before.
        const delay = Math.min(
          WS_MAX_RECONNECT_DELAY_MS,
          WS_RECONNECT_DELAY_MS * 2 ** attemptsRef.current
        );
        attemptsRef.current += 1;
        reconnectRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }, [userId, addToast, queryClient]);

  useEffect(() => {
    if (!userId) return;

    activeRef.current = true;
    attemptsRef.current = 0;
    connect();

    // After the attempt budget is spent the socket stays down until something
    // suggests the network is back, rather than never recovering.
    const resume = () => {
      if (!activeRef.current) return;
      // CONNECTING counts as healthy. Treating only OPEN as healthy meant
      // every focus event tore down a handshake that was still in progress,
      // so an unlucky tab could never finish connecting.
      if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;
      attemptsRef.current = 0;
      clearTimers();
      connect();
    };

    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);

    return () => {
      activeRef.current = false;
      useRealtimeStore.getState().setConnected(false);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      clearTimers();
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close(1000, 'Component unmount');
        socketRef.current = null;
      }
    };
  }, [userId, connect, clearTimers]);

  return socketRef;
}
