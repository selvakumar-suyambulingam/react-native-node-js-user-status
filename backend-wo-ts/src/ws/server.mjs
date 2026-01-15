import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;
  clients = new Map(); // userKey -> Set<WebSocket>

  constructor(server) {
    this.serverId = config.serverId || crypto.randomUUID(); // stable per instance recommended
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));
    console.log('WebSocket server initialized on /ws, serverId=', this.serverId);

    // Server-side liveness + presence refresh
    this.startHeartbeatCheck();
  }

  handleConnection(ws) {
    ws.isAlive = true;
    ws.userKey = null;
    ws.nextPresenceRefreshAt = 0;

    ws.on('pong', async () => {
      ws.isAlive = true;

      // Presence refresh only when we know the socket is alive.
      // Throttle to reduce Redis load.
      if (ws.userKey) {
        const now = Date.now();
        const refreshEveryMs = Math.max(
          10_000,
          Math.floor((config.presenceTtlSeconds * 1000) / 2)
        );

        if (now >= (ws.nextPresenceRefreshAt || 0)) {
          try {
            await presenceService.refreshPresence(ws.userKey, this.serverId);
            ws.nextPresenceRefreshAt = now + refreshEveryMs;
          } catch (e) {
            console.error('refreshPresence failed:', e);
          }
        }
      }
    });

    ws.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      try {
        await this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Internal error' }));
      }
    });

    ws.on('close', async () => {
      await this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  async handleMessage(ws, message) {
    switch (message.type) {
      case 'auth':
        await this.handleAuth(ws, message);
        break;

      // Optional: if your client already sends ping, keep it lightweight.
      // Do NOT refresh Redis here; liveness + refresh happens on pong.
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }

  async handleAuth(ws, message) {
    const { email } = message;
    if (!email || typeof email !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'Email is required' }));
      return;
    }

    const normalized = presenceService.normalizeEmail(email);
    if (!presenceService.isValidEmail(normalized)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid email format' }));
      return;
    }

    // If already authed, first detach from old userKey to avoid leaks
    if (ws.userKey) this.detachClient(ws);

    ws.userKey = normalized;

    if (!this.clients.has(ws.userKey)) this.clients.set(ws.userKey, new Set());
    this.clients.get(ws.userKey).add(ws);

    // Set online with TTL (statusChanged means it was previously offline/missing)
    const { statusChanged, lastSeen } = await presenceService.setOnline(
      ws.userKey,
      this.serverId
    );

    ws.send(
      JSON.stringify({
        type: 'auth:ok',
        email: ws.userKey,
        serverId: this.serverId,
        heartbeatMs: config.heartbeatIntervalMs,
        ttlSeconds: config.presenceTtlSeconds,
        lastSeen,
      })
    );

    // If you have pub/sub for presence updates, publish here when statusChanged.
    // (Do NOT broadcast to all sockets globally; it must be targeted.)
    if (statusChanged) {
      await presenceService.publishPresenceUpdate(ws.userKey, true);
    }
  }

  detachClient(ws) {
    if (!ws.userKey) return;
    const connections = this.clients.get(ws.userKey);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) this.clients.delete(ws.userKey);
    }
    ws.userKey = null;
  }

  async handleDisconnect(ws) {
    const userKey = ws.userKey;
    this.detachClient(ws);

    if (!userKey) return;

    // IMPORTANT:
    // Do NOT mark offline immediately by counting connections (race across servers).
    // Let TTL expiry declare offline.
    //
    // Optional optimization: if this server has no more local sockets for that user,
    // you MAY attempt a safe delete ONLY if this server still owns the presence key.
    const stillHasLocal = this.clients.has(userKey);
    if (!stillHasLocal) {
      try {
        const deleted = await presenceService.safeClearIfOwned(userKey, this.serverId);
        if (deleted) {
          // Optional: publish offline immediately on clean disconnect.
          // But be careful: in mobile networks, clean close is not guaranteed.
          await presenceService.publishPresenceUpdate(userKey, false);
        }
      } catch (e) {
        console.error('safeClearIfOwned failed:', e);
      }
    }
  }

  startHeartbeatCheck() {
    const intervalMs = config.heartbeatIntervalMs || 30_000;

    setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          // terminate triggers close -> handleDisconnect
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping(); // pong will flip isAlive and refresh presence (throttled)
      }
    }, intervalMs);
  }
}
