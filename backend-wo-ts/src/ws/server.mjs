import { WebSocketServer, WebSocket } from 'ws';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;
  clients = new Map(); // email -> Set<WebSocket>

  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));

    presenceService.onPresenceUpdate((data) => {
      console.log(
        `Received presence update: ${data.email} -> ${data.online ? 'ONLINE' : 'OFFLINE'}`
      );
      this.broadcastPresenceUpdate(data.email, data.online);
    });

    console.log('WebSocket server initialized on /ws');

    // IMPORTANT: start server-side liveness ping/pong
    this.startHeartbeatCheck();
  }

  handleConnection(ws) {
    console.log('New WebSocket connection');

    ws.isAlive = true;
    ws.nextPresenceRefreshAt = 0; // throttle redis refresh per connection

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', async () => {
      console.log(`WebSocket closed for: ${ws.email || 'unknown'}`);
      await this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  async handleDisconnect(ws) {
    if (!ws.email) return;

    const connections = this.clients.get(ws.email);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) this.clients.delete(ws.email);
    }

    // Decrement in Redis
    const remaining = await presenceService.decrementConnectionCount(ws.email);
    console.log(`Remaining connections for ${ws.email}: ${remaining}`);

    // If last connection, mark offline and publish update
    if (remaining === 0) {
      const statusChanged = await presenceService.setOffline(ws.email);
      if (statusChanged) {
        await presenceService.publishPresenceUpdate(ws.email, false);
      }
    }
  }

  async handleMessage(ws, message) {
    switch (message.type) {
      case 'auth':
        await this.handleAuth(ws, message);
        break;

      case 'ping':
        // Keep for your client if you already implemented it,
        // but Redis refresh is THROTTLED.
        await this.handleClientPing(ws);
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

    ws.email = normalized;

    if (!this.clients.has(normalized)) this.clients.set(normalized, new Set());
    this.clients.get(normalized).add(ws);

    // Crash-safe: increment + set TTL on connections key
    const connectionCount = await presenceService.incrementConnectionCount(normalized);

    // Set online (with TTL) - returns true only if it was offline
    const statusChanged = await presenceService.setOnline(normalized);

    // Reply to client
    const lastSeen = await presenceService.getLastSeen(normalized);
    ws.send(
      JSON.stringify({
        type: 'auth:ok',
        email: normalized,
        heartbeatMs: config.heartbeatIntervalMs,
        ttlSeconds: config.presenceTtlSeconds,
        lastSeen,
        connectionCount,
      })
    );

    if (statusChanged) {
      await presenceService.publishPresenceUpdate(normalized, true);
    }
  }

  async handleClientPing(ws) {
    if (!ws.email) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    const now = Date.now();
    // Refresh Redis at most once per half TTL (e.g., TTL 90s => refresh every 45s)
    const refreshEveryMs = Math.max(10_000, Math.floor((config.presenceTtlSeconds * 1000) / 2));

    if (now >= (ws.nextPresenceRefreshAt || 0)) {
      await presenceService.refreshPresence(ws.email);
      ws.nextPresenceRefreshAt = now + refreshEveryMs;
    }

    ws.send(JSON.stringify({ type: 'pong' }));
  }

  broadcastPresenceUpdate(email, online) {
    const payload = JSON.stringify({
      type: 'presence:update',
      email,
      online,
      timestamp: Date.now(),
    });

    let sent = 0;
    this.clients.forEach((connections) => {
      connections.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
          sent++;
        }
      });
    });

    console.log(
      `Broadcasted presence update to ${sent} connection(s): ${email} -> ${online ? 'ONLINE' : 'OFFLINE'}`
    );
  }

  startHeartbeatCheck() {
    const intervalMs = 30_000;

    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log(`Terminating dead connection for: ${ws.email || 'unknown'}`);
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, intervalMs);
  }
}
