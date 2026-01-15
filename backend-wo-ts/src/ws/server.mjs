import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;
  clients = new Map(); // userKey -> Set<WebSocket>

  // Subscription tracking for scalable presence updates
  subscriptions = new Map(); // WebSocket -> Set<emails they watch>
  watchedBy = new Map(); // email -> Set<WebSocket watching>

  // Rate limiting
  connectionsByIp = new Map(); // IP -> count
  subscribeRateLimit = new Map(); // WebSocket -> { count, resetAt }

  // Redis subscriber for receiving presence updates
  subClient = null;

  constructor(server) {
    this.serverId = config.serverId;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));
    console.log('WebSocket server initialized on /ws, serverId=', this.serverId);

    // Server-side liveness + presence refresh
    this.startHeartbeatCheck();

    // Start Pub/Sub listener for presence updates from other servers
    this.startPubSubListener();

    // Clean up rate limit maps periodically
    setInterval(() => this.cleanupRateLimits(), 60_000);
  }

  /**
   * Clean up stale rate limit entries
   */
  cleanupRateLimits() {
    const now = Date.now();
    for (const [ws, limit] of this.subscribeRateLimit) {
      if (limit.resetAt < now) {
        this.subscribeRateLimit.delete(ws);
      }
    }
  }

  /**
   * Check connection rate limit by IP
   */
  checkConnectionLimit(ip) {
    const count = this.connectionsByIp.get(ip) || 0;
    if (count >= config.maxConnectionsPerIp) {
      return false;
    }
    this.connectionsByIp.set(ip, count + 1);
    return true;
  }

  /**
   * Decrement connection count for IP
   */
  decrementConnectionCount(ip) {
    const count = this.connectionsByIp.get(ip) || 0;
    if (count <= 1) {
      this.connectionsByIp.delete(ip);
    } else {
      this.connectionsByIp.set(ip, count - 1);
    }
  }

  /**
   * Check subscribe rate limit
   */
  checkSubscribeRateLimit(ws) {
    const now = Date.now();
    let limit = this.subscribeRateLimit.get(ws);

    if (!limit || limit.resetAt < now) {
      // Reset window
      limit = { count: 0, resetAt: now + 60_000 };
    }

    if (limit.count >= config.subscribeRateLimitPerMinute) {
      return false;
    }

    limit.count++;
    this.subscribeRateLimit.set(ws, limit);
    return true;
  }

  /**
   * Subscribe to Redis pub/sub channel for presence updates.
   * This allows multiple WebSocket servers to coordinate presence broadcasts.
   */
  async startPubSubListener() {
    try {
      this.subClient = createClient({ url: config.redisUrl });
      this.subClient.on('error', (err) => console.error('Redis sub error:', err));

      await this.subClient.connect();

      await this.subClient.subscribe(config.presenceChannel, (message) => {
        try {
          const data = JSON.parse(message);
          this.handlePresenceUpdate(data);
        } catch (e) {
          console.error('Failed to parse presence update:', e);
        }
      });

      console.log(`Subscribed to Redis channel: ${config.presenceChannel}`);
    } catch (e) {
      console.error('Failed to start pub/sub listener:', e);
    }
  }

  /**
   * Handle incoming presence update from Redis pub/sub.
   * Only forward to locally connected clients who subscribed to this user.
   */
  handlePresenceUpdate(data) {
    const { email, online, targetServers } = data;

    // If targetServers specified, only process if this server is targeted
    if (targetServers && Array.isArray(targetServers)) {
      if (!targetServers.includes(this.serverId)) {
        return; // This update is not for us
      }
    }

    // Get local clients watching this email
    const watchers = this.watchedBy.get(email);
    if (!watchers || watchers.size === 0) return;

    const update = JSON.stringify({
      type: 'presence:update',
      email,
      online
    });

    // Send only to subscribed local clients
    for (const ws of watchers) {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(update);
      }
    }
  }

  handleConnection(ws, req) {
    // Get client IP for rate limiting
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.socket.remoteAddress ||
               'unknown';
    ws.clientIp = ip;

    // Check connection rate limit
    if (!this.checkConnectionLimit(ip)) {
      console.log(`Connection rejected: too many connections from ${ip}`);
      ws.close(1008, 'Too many connections');
      return;
    }

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

      case 'subscribe':
        await this.handleSubscribe(ws, message);
        break;

      case 'unsubscribe':
        await this.handleUnsubscribe(ws, message);
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

  /**
   * Handle client subscribing to specific users' presence.
   * This is the key to scalability - clients only receive updates they care about.
   */
  async handleSubscribe(ws, message) {
    const { emails } = message;

    if (!Array.isArray(emails)) {
      ws.send(JSON.stringify({ type: 'error', message: 'emails must be an array' }));
      return;
    }

    if (!ws.userKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'Must authenticate before subscribing' }));
      return;
    }

    // Rate limit check
    if (!this.checkSubscribeRateLimit(ws)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded. Try again later.'
      }));
      return;
    }

    // Get or create subscription set for this client
    let clientSubs = this.subscriptions.get(ws);
    if (!clientSubs) {
      clientSubs = new Set();
      this.subscriptions.set(ws, clientSubs);
    }

    // Limit subscriptions per client to prevent abuse
    const availableSlots = config.maxSubscriptionsPerClient - clientSubs.size;
    if (availableSlots <= 0) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Maximum subscriptions (${config.maxSubscriptionsPerClient}) reached`
        })
      );
      return;
    }

    // Filter out already subscribed and limit to available slots
    const toAdd = [];
    for (const email of emails) {
      if (toAdd.length >= availableSlots) break;

      const normalized = presenceService.normalizeEmail(email);
      if (!clientSubs.has(normalized)) {
        toAdd.push(normalized);
      }
    }

    if (toAdd.length === 0) {
      ws.send(JSON.stringify({ type: 'subscribe:ok', statuses: [] }));
      return;
    }

    // Register locally
    for (const email of toAdd) {
      clientSubs.add(email);

      if (!this.watchedBy.has(email)) {
        this.watchedBy.set(email, new Set());
      }
      this.watchedBy.get(email).add(ws);
    }

    // Register in Redis for cross-server routing
    await presenceService.addWatcherBatch(toAdd, this.serverId);

    // Get current presence status for all subscribed users
    const statuses = await presenceService.getBatchPresence(toAdd);

    ws.send(
      JSON.stringify({
        type: 'subscribe:ok',
        statuses
      })
    );
  }

  /**
   * Handle client unsubscribing from users.
   */
  async handleUnsubscribe(ws, message) {
    const { emails } = message;

    if (!Array.isArray(emails)) {
      ws.send(JSON.stringify({ type: 'error', message: 'emails must be an array' }));
      return;
    }

    const clientSubs = this.subscriptions.get(ws);
    if (!clientSubs) return;

    const toRemoveFromRedis = [];

    for (const email of emails) {
      const normalized = presenceService.normalizeEmail(email);
      clientSubs.delete(normalized);

      const watchers = this.watchedBy.get(normalized);
      if (watchers) {
        watchers.delete(ws);
        // If no more local clients watching, remove from Redis
        if (watchers.size === 0) {
          this.watchedBy.delete(normalized);
          toRemoveFromRedis.push(normalized);
        }
      }
    }

    // Batch remove from Redis
    if (toRemoveFromRedis.length > 0) {
      await presenceService.removeWatcherBatch(toRemoveFromRedis, this.serverId);
    }

    ws.send(JSON.stringify({ type: 'unsubscribe:ok' }));
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

    // Publish presence update via targeted pub/sub (only to interested servers)
    if (statusChanged) {
      await presenceService.publishTargetedPresenceUpdate(ws.userKey, true);
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
    // Decrement IP connection count
    if (ws.clientIp) {
      this.decrementConnectionCount(ws.clientIp);
    }

    // Clean up rate limit entry
    this.subscribeRateLimit.delete(ws);

    // Clean up subscriptions first
    await this.cleanupSubscriptions(ws);

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
          // Publish offline via targeted pub/sub (only to interested servers)
          await presenceService.publishTargetedPresenceUpdate(userKey, false);
        }
      } catch (e) {
        console.error('safeClearIfOwned failed:', e);
      }
    }
  }

  /**
   * Clean up all subscriptions for a disconnecting client.
   * Removes from local tracking and updates Redis watchers.
   */
  async cleanupSubscriptions(ws) {
    const clientSubs = this.subscriptions.get(ws);
    if (!clientSubs || clientSubs.size === 0) return;

    const toRemoveFromRedis = [];

    for (const email of clientSubs) {
      const watchers = this.watchedBy.get(email);
      if (watchers) {
        watchers.delete(ws);
        // If no more local clients watching this email, remove server from Redis
        if (watchers.size === 0) {
          this.watchedBy.delete(email);
          toRemoveFromRedis.push(email);
        }
      }
    }

    this.subscriptions.delete(ws);

    // Batch remove from Redis
    if (toRemoveFromRedis.length > 0) {
      try {
        await presenceService.removeWatcherBatch(toRemoveFromRedis, this.serverId);
      } catch (e) {
        console.error('Failed to cleanup watchers from Redis:', e);
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
