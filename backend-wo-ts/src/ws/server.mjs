import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;

  // Auth sockets by user
  clients = new Map(); // userEmail -> Set<WebSocket>

  // Focus tracking (LOCAL ONLY)
  focusedBySocket = new Map(); // ws -> Set<email>
  focusedSocketsByEmail = new Map(); // email -> Set<ws>

  // Rate limiting
  connectionsByIp = new Map(); // IP -> count
  focusRateLimit = new Map(); // ws -> { count, resetAt }

  // Redis sub for presence flips
  subClient = null;

  constructor(server) {
    this.serverId = config.serverId;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));
    console.log('WebSocket server initialized on /ws, serverId=', this.serverId);

    this.startHeartbeatCheck();
    this.startFlipListener();

    setInterval(() => this.cleanupRateLimits(), 60_000);
  }

  cleanupRateLimits() {
    const now = Date.now();
    for (const [ws, limit] of this.focusRateLimit) {
      if (limit.resetAt < now) this.focusRateLimit.delete(ws);
    }
  }

  checkConnectionLimit(ip) {
    const count = this.connectionsByIp.get(ip) || 0;
    if (count >= config.maxConnectionsPerIp) return false;
    this.connectionsByIp.set(ip, count + 1);
    return true;
  }

  decrementConnectionCount(ip) {
    const count = this.connectionsByIp.get(ip) || 0;
    if (count <= 1) this.connectionsByIp.delete(ip);
    else this.connectionsByIp.set(ip, count - 1);
  }

  checkFocusRateLimit(ws) {
    const now = Date.now();
    let limit = this.focusRateLimit.get(ws);

    if (!limit || limit.resetAt < now) limit = { count: 0, resetAt: now + 60_000 };
    if (limit.count >= (config.focusRateLimitPerMinute ?? 60)) return false;

    limit.count++;
    this.focusRateLimit.set(ws, limit);
    return true;
  }

  // -------- Pub/Sub: subscribe to sharded presence flip channels --------
  async startFlipListener() {
    try {
      this.subClient = createClient({ url: config.redisUrl });
      this.subClient.on('error', (err) => console.error('Redis sub error:', err));
      await this.subClient.connect();

      const shardCount = config.presenceShardCount ?? 64;

      for (let shard = 0; shard < shardCount; shard++) {
        const channel = `presence:flip:${shard}`;
        await this.subClient.subscribe(channel, (message) => {
          try {
            const data = JSON.parse(message);
            this.onPresenceFlip(data);
          } catch (e) {
            console.error('Failed to parse presence flip:', e);
          }
        });
      }

      console.log(`Subscribed to ${shardCount} presence flip shards`);
    } catch (e) {
      console.error('Failed to start flip listener:', e);
    }
  }

  onPresenceFlip(data) {
    const { email, online } = data;
    if (!email) return;

    const watchers = this.focusedSocketsByEmail.get(email);
    if (!watchers || watchers.size === 0) return;

    const payload = JSON.stringify({
      type: 'presence:update',
      email,
      online,
    });

    for (const ws of watchers) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  // -------- WebSocket connection handling --------
  handleConnection(ws, req) {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    ws.clientIp = ip;

    if (!this.checkConnectionLimit(ip)) {
      ws.close(1008, 'Too many connections');
      return;
    }

    ws.isAlive = true;
    ws.userKey = null;
    ws.nextPresenceRefreshAt = 0;

    ws.on('pong', async () => {
      ws.isAlive = true;

      // Keep Redis refresh LOW:
      // refresh presence only if user is authenticated AND has at least 1 focused target
      if (!ws.userKey) return;

      const focused = this.focusedBySocket.get(ws);
      if (!focused || focused.size === 0) return;

      const now = Date.now();
      const refreshEveryMs = Math.max(
        20_000,
        Math.floor((config.presenceTtlSeconds * 1000) / 2)
      );

      if (now < (ws.nextPresenceRefreshAt || 0)) return;

      try {
        await presenceService.refreshPresence(ws.userKey, this.serverId);
        ws.nextPresenceRefreshAt = now + refreshEveryMs;
      } catch (e) {
        console.error('refreshPresence failed:', e);
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

      case 'presence:focus':
        await this.handleFocus(ws, message);
        break;

      case 'presence:blur':
        await this.handleBlur(ws, message);
        break;

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

    // detach from old identity if any
    if (ws.userKey) this.detachClient(ws);

    ws.userKey = normalized;
    if (!this.clients.has(ws.userKey)) this.clients.set(ws.userKey, new Set());
    this.clients.get(ws.userKey).add(ws);

    const { statusChanged, lastSeen } = await presenceService.setOnline(ws.userKey, this.serverId);

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

    // publish flip only if offline -> online
    if (statusChanged) {
      try {
        await presenceService.publishPresenceFlip(ws.userKey, true);
      } catch (e) {
        console.error('publishPresenceFlip(online) failed:', e);
      }
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

  // -------- Focus/Blur --------
  async handleFocus(ws, message) {
    const { emails } = message;

    if (!Array.isArray(emails)) {
      ws.send(JSON.stringify({ type: 'error', message: 'emails must be an array' }));
      return;
    }

    if (!ws.userKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Must authenticate before focus' }));
      return;
    }

    if (!this.checkFocusRateLimit(ws)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Try again later.' }));
      return;
    }

    // Cap realtime focus per socket
    const maxFocus = config.maxFocusPerClient ?? 100;

    let set = this.focusedBySocket.get(ws);
    if (!set) {
      set = new Set();
      this.focusedBySocket.set(ws, set);
    }

    const available = maxFocus - set.size;
    if (available <= 0) {
      ws.send(JSON.stringify({ type: 'presence:focus:ok', statuses: [] }));
      return;
    }

    const toAdd = [];
    for (const email of emails) {
      if (toAdd.length >= available) break;
      const normalized = presenceService.normalizeEmail(email);
      if (!presenceService.isValidEmail(normalized)) continue;
      if (!set.has(normalized)) toAdd.push(normalized);
    }

    if (toAdd.length === 0) {
      ws.send(JSON.stringify({ type: 'presence:focus:ok', statuses: [] }));
      return;
    }

    // Register locally
    for (const email of toAdd) {
      set.add(email);
      if (!this.focusedSocketsByEmail.has(email)) this.focusedSocketsByEmail.set(email, new Set());
      this.focusedSocketsByEmail.get(email).add(ws);
    }

    // Snapshot for focused emails so UI can update instantly
    // (this is still pull, but fast because it's Redis pipeline)
    const statuses = await presenceService.getBatchPresenceForList(toAdd);

    ws.send(JSON.stringify({ type: 'presence:focus:ok', statuses }));
  }

  async handleBlur(ws, message) {
    const { emails } = message;
    if (!Array.isArray(emails)) {
      ws.send(JSON.stringify({ type: 'error', message: 'emails must be an array' }));
      return;
    }

    const set = this.focusedBySocket.get(ws);
    if (!set || set.size === 0) {
      ws.send(JSON.stringify({ type: 'presence:blur:ok' }));
      return;
    }

    for (const email of emails) {
      const normalized = presenceService.normalizeEmail(email);
      if (!set.has(normalized)) continue;

      set.delete(normalized);

      const watchers = this.focusedSocketsByEmail.get(normalized);
      if (watchers) {
        watchers.delete(ws);
        if (watchers.size === 0) this.focusedSocketsByEmail.delete(normalized);
      }
    }

    if (set.size === 0) this.focusedBySocket.delete(ws);

    ws.send(JSON.stringify({ type: 'presence:blur:ok' }));
  }

  // -------- Disconnect cleanup --------
  async handleDisconnect(ws) {
    if (ws.clientIp) this.decrementConnectionCount(ws.clientIp);
    this.focusRateLimit.delete(ws);

    // remove focus mappings
    const focused = this.focusedBySocket.get(ws);
    if (focused && focused.size > 0) {
      for (const email of focused) {
        const watchers = this.focusedSocketsByEmail.get(email);
        if (watchers) {
          watchers.delete(ws);
          if (watchers.size === 0) this.focusedSocketsByEmail.delete(email);
        }
      }
    }
    this.focusedBySocket.delete(ws);

    const userKey = ws.userKey;
    this.detachClient(ws);
    if (!userKey) return;

    // Optional early offline:
    // only when this server has no more local sockets for this user.
    const stillHasLocal = this.clients.has(userKey);
    if (!stillHasLocal) {
      try {
        const deleted = await presenceService.safeClearIfOwned(userKey, this.serverId);
        if (deleted) {
          await presenceService.publishPresenceFlip(userKey, false);
        }
      } catch (e) {
        console.error('safeClearIfOwned failed:', e);
      }
    }
  }

  // -------- Heartbeat --------
  startHeartbeatCheck() {
    const intervalMs = config.heartbeatIntervalMs || 45_000;

    setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, intervalMs);
  }
}
