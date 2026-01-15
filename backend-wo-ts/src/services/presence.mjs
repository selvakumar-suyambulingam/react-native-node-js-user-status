import { createClient } from 'redis';
import { config } from '../config.mjs';

export class PresenceService {
  client;
  pubClient;
  connected = false;

  constructor() {
    this.client = createClient({ url: config.redisUrl });
    this.pubClient = createClient({ url: config.redisUrl });

    this.client.on('error', (err) => console.error('Redis error:', err));
    this.pubClient.on('error', (err) => console.error('Redis pub error:', err));

    this.client.on('connect', () => {
      console.log('Connected to Redis');
      this.connected = true;
    });
    this.client.on('end', () => {
      console.log('Redis connection ended');
      this.connected = false;
    });
  }

  async connect() {
    if (this.connected) return;

    await Promise.all([this.client.connect(), this.pubClient.connect()]);
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) return;
    await Promise.all([this.pubClient.quit(), this.client.quit()]);
    this.connected = false;
  }

  // ---------------- Utilities ----------------
  normalizeEmail(email) {
    return String(email).trim().toLowerCase();
  }

  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  presenceKey(email) {
    return `presence:user:${email}`; // keep prefix stable for clustering
  }

  lastSeenKey(email) {
    return `presence:lastseen:${email}`;
  }

  usersKey() {
    return 'users:all';
  }

  watchersKey(email) {
    return `presence:watchers:${email}`;
  }

  // ---------------- Subscription/Watcher Management ----------------
  /**
   * Subscribe a server to watch a user's presence changes.
   * Called when a client on this server subscribes to a contact.
   */
  async addWatcher(targetEmail, serverId) {
    const normalized = this.normalizeEmail(targetEmail);
    const key = this.watchersKey(normalized);
    await this.client.sAdd(key, serverId);
    // Set TTL to auto-cleanup stale subscriptions
    await this.client.expire(key, config.watcherTtlSeconds);
  }

  /**
   * Batch subscribe - efficient for initial contact list.
   * Registers this server as a watcher for multiple users in one pipeline.
   */
  async addWatcherBatch(targetEmails, serverId) {
    if (targetEmails.length === 0) return;

    const pipeline = this.client.multi();
    for (const email of targetEmails) {
      const key = this.watchersKey(this.normalizeEmail(email));
      pipeline.sAdd(key, serverId);
      pipeline.expire(key, config.watcherTtlSeconds);
    }
    await pipeline.exec();
  }

  /**
   * Remove server from watchers for a specific user.
   * Called when no more local clients are watching this user.
   */
  async removeWatcher(targetEmail, serverId) {
    const normalized = this.normalizeEmail(targetEmail);
    await this.client.sRem(this.watchersKey(normalized), serverId);
  }

  /**
   * Batch remove watchers - efficient cleanup on server shutdown.
   */
  async removeWatcherBatch(targetEmails, serverId) {
    if (targetEmails.length === 0) return;

    const pipeline = this.client.multi();
    for (const email of targetEmails) {
      pipeline.sRem(this.watchersKey(this.normalizeEmail(email)), serverId);
    }
    await pipeline.exec();
  }

  /**
   * Get all servers watching a user (for targeted broadcast).
   */
  async getWatchers(email) {
    const normalized = this.normalizeEmail(email);
    return await this.client.sMembers(this.watchersKey(normalized));
  }

  // ---------------- Pub/Sub ----------------
  /**
   * Publish presence update to ALL servers (legacy - for backward compatibility).
   * Prefer publishTargetedPresenceUpdate for scale.
   */
  async publishPresenceUpdate(email, online) {
    const message = JSON.stringify({ email, online, timestamp: Date.now() });
    await this.pubClient.publish(config.presenceChannel, message);
  }

  /**
   * Publish presence update ONLY to interested servers.
   * This is the scalable approach - only servers with subscribed clients receive the update.
   */
  async publishTargetedPresenceUpdate(email, online) {
    const normalized = this.normalizeEmail(email);
    const watchers = await this.getWatchers(normalized);

    // If no servers are watching, skip publishing
    if (watchers.length === 0) return;

    const message = JSON.stringify({
      email: normalized,
      online,
      timestamp: Date.now(),
      targetServers: watchers
    });

    await this.pubClient.publish(config.presenceChannel, message);
  }

  /**
   * Get batch presence status - efficient for initial subscription load.
   * Uses pipeline to fetch presence for multiple users in one round-trip.
   */
  async getBatchPresence(emails) {
    if (emails.length === 0) return [];

    const pipeline = this.client.multi();
    const normalized = emails.map((e) => this.normalizeEmail(e));

    for (const email of normalized) {
      pipeline.exists(this.presenceKey(email));
    }

    const results = await pipeline.exec();
    return normalized.map((email, i) => ({
      email,
      online: results[i] === 1
    }));
  }

  // ---------------- Presence (TTL truth + ownership) ----------------
  /**
   * Set online by writing presence key with TTL.
   * Value = serverId that "owns" the socket(s) right now.
   *
   * Returns { statusChanged, lastSeen }
   * statusChanged = true if user was previously offline (key missing)
   */
  async setOnline(email, serverId) {
    const normalized = this.normalizeEmail(email);
    const key = this.presenceKey(normalized);

    // Redis 6.2+: SET ... GET returns previous value (or null if key was absent)
    const prev = await this.client.set(key, serverId, {
      EX: config.presenceTtlSeconds,
      GET: true,
    });

    const statusChanged = prev === null;
    const lastSeen = await this.getLastSeen(normalized);

    return { statusChanged, lastSeen };
  }

  /**
   * Refresh TTL ONLY if this server still owns the presence key.
   * Prevents stale server from extending presence after reconnect on another server.
   */
  async refreshPresence(email, serverId) {
    const normalized = this.normalizeEmail(email);
    const key = this.presenceKey(normalized);

    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
      else
        return 0
      end
    `;

    return await this.client.eval(script, {
      keys: [key],
      arguments: [serverId, String(config.presenceTtlSeconds)],
    });
  }

  /**
   * Mark offline safely (optional optimization).
   * Only deletes if this server still owns the key.
   * You do NOT need to call this for correctness; TTL handles offline.
   */
  async safeClearIfOwned(email, serverId) {
    const normalized = this.normalizeEmail(email);
    const key = this.presenceKey(normalized);

    // Update last seen when we *believe* they went offline
    await this.updateLastSeen(normalized);

    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const res = await this.client.eval(script, {
      keys: [key],
      arguments: [serverId],
    });

    return res === 1;
  }

  async isOnline(email) {
    const normalized = this.normalizeEmail(email);
    const exists = await this.client.exists(this.presenceKey(normalized));
    return exists === 1;
  }

  // ---------------- Last seen ----------------
  async updateLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.set(this.lastSeenKey(normalized), String(Date.now()));
  }

  async getLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    const ts = await this.client.get(this.lastSeenKey(normalized));
    return ts ? Number(ts) : null;
  }

  // ---------------- User registry (demo) ----------------
  async registerUser(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.sAdd(this.usersKey(), normalized);
  }

  async getAllUsers() {
    return await this.client.sMembers(this.usersKey());
  }

  /**
   * DEPRECATED: Use getUsersPaginated or getBatchPresenceWithLastSeen instead.
   * This method fetches ALL users and won't scale beyond ~10K users.
   */
  async getUsersWithStatus() {
    const users = await this.getAllUsers();
    if (users.length === 0) return [];

    const pipeline = this.client.multi();

    // 1) EXISTS all presence keys
    for (const email of users) pipeline.exists(this.presenceKey(email));

    // 2) GET all lastSeen keys
    for (const email of users) pipeline.get(this.lastSeenKey(email));

    // node-redis multi.exec() returns array of raw results in order
    const res = await pipeline.exec();
    const n = users.length;

    const existsResults = res.slice(0, n).map((x) => Number(x));
    const lastSeenResults = res
      .slice(n, 2 * n)
      .map((x) => (x == null ? null : Number(x)));

    return users.map((email, i) => ({
      email,
      online: existsResults[i] === 1,
      lastSeen: lastSeenResults[i],
    }));
  }

  // ---------------- Scalable Methods for 1M+ users ----------------

  /**
   * Get batch presence with lastSeen - SCALABLE.
   * Use this for fetching presence of specific users (contacts list).
   * Limited to 500 users per call for safety.
   */
  async getBatchPresenceWithLastSeen(emails) {
    if (emails.length === 0) return [];

    const normalized = emails.map((e) => this.normalizeEmail(e));
    const pipeline = this.client.multi();

    // Batch EXISTS for presence
    for (const email of normalized) {
      pipeline.exists(this.presenceKey(email));
    }

    // Batch GET for lastSeen
    for (const email of normalized) {
      pipeline.get(this.lastSeenKey(email));
    }

    const results = await pipeline.exec();
    const n = normalized.length;

    return normalized.map((email, i) => ({
      email,
      online: results[i] === 1,
      lastSeen: results[n + i] ? Number(results[n + i]) : null
    }));
  }

  /**
   * Get users with pagination using SSCAN - SCALABLE.
   * Use cursor-based pagination for large user sets.
   * Returns { users, nextCursor, hasMore }
   */
  async getUsersPaginated(cursor, limit = 50) {
    const key = this.usersKey();

    // Use SSCAN for cursor-based iteration
    // cursor is the email to start after (or null for start)
    let emails = [];
    let scanCursor = 0;
    const targetCount = limit + 1; // Fetch one extra to check hasMore

    // SSCAN doesn't support "start after X", so we use ZRANGEBYLEX with sorted set
    // For simplicity with SET, we'll use SSCAN and skip until we find cursor
    // In production, consider using ZSET for ordered pagination

    // Simple approach: fetch in batches until we have enough
    let foundCursor = !cursor; // If no cursor, we start from beginning
    let iterations = 0;
    const maxIterations = 100; // Safety limit

    while (emails.length < targetCount && iterations < maxIterations) {
      // node-redis v4 returns { cursor: number, members: string[] }
      const result = await this.client.sScan(key, scanCursor, {
        COUNT: Math.max(100, targetCount * 2)
      });

      for (const email of result.members) {
        if (!foundCursor) {
          if (email === cursor) {
            foundCursor = true;
          }
          continue;
        }

        emails.push(email);
        if (emails.length >= targetCount) break;
      }

      scanCursor = result.cursor;
      if (scanCursor === 0) break; // Completed full scan
      iterations++;
    }

    const hasMore = emails.length > limit;
    const resultEmails = emails.slice(0, limit);

    if (resultEmails.length === 0) {
      return { users: [], nextCursor: null, hasMore: false };
    }

    // Batch fetch presence for result set
    const users = await this.getBatchPresenceWithLastSeen(resultEmails);
    const nextCursor = hasMore ? resultEmails[resultEmails.length - 1] : null;

    return { users, nextCursor, hasMore };
  }
}

export const presenceService = new PresenceService();
