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

  // ---------------- Pub/Sub ----------------
  async publishPresenceUpdate(email, online) {
    const message = JSON.stringify({ email, online, timestamp: Date.now() });
    await this.pubClient.publish('presence:updates', message);
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
   * IMPORTANT SCALABILITY FIX:
   * Your old version did N calls for isOnline + N calls for lastSeen + N calls for connectionCount.
   * This version batches into pipelines.
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
}

export const presenceService = new PresenceService();
