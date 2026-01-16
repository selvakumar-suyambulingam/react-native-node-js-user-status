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

  // Online truth (TTL)
  presenceKey(email) {
    return `presence:user:${email}`; // value = serverId, TTL truth
  }

  // "Last seen" (set on offline)
  lastSeenKey(email) {
    return `presence:lastseen:${email}`;
  }

  // "Active recently" (LinkedIn-style)
  activeKey(email) {
    return `presence:active:${email}`; // ms timestamp
  }

  // Watcher registry for targeted fanout (1M-scale)
  watchersKey(email) {
    return `presence:watchers:${email}`; // SET(serverId)
  }

  serverChannel(serverId) {
    return `presence:server:${serverId}`;
  }

  bucketize(nowMs, lastActiveAtMs, online) {
    if (online) return 'online_now';
    if (!lastActiveAtMs) return 'unknown';

    const d = nowMs - lastActiveAtMs;
    if (d < 10_000) return 'active_10s';
    if (d < 60_000) return 'active_1m';
    if (d < 5 * 60_000) return 'active_5m';
    if (d < 15 * 60_000) return 'active_15m';
    if (d < 60 * 60_000) return 'active_1h';
    if (d < 24 * 60 * 60_000) return 'active_today';
    return 'inactive';
  }

  // ---------------- Activity (LinkedIn-style) ----------------
  async touchActive(email) {
    const normalized = this.normalizeEmail(email);
    const now = Date.now();
    await this.client.set(this.activeKey(normalized), String(now));
    return now;
  }

  // ---------------- Pub/Sub (presence flips only) ----------------
  async publishPresenceFlip(email, online) {
    const normalized = this.normalizeEmail(email);

    // Targeted delivery: only publish to WS servers that currently have watchers
    // for this email. This avoids broadcasting flips to every node.
    const watchers = await this.client.sMembers(this.watchersKey(normalized));
    if (!watchers || watchers.length === 0) return;

    const msg = JSON.stringify({ email: normalized, online, ts: Date.now() });

    // Publish to each server's dedicated channel.
    // Note: Redis PUBLISH is fire-and-forget; correctness comes from snapshot pulls.
    const pipeline = this.pubClient.multi();
    for (const serverId of watchers) {
      if (!serverId) continue;
      pipeline.publish(this.serverChannel(serverId), msg);
    }
    await pipeline.exec();
  }

  /**
   * Register that this WS server is watching these emails.
   * Stored in Redis so publishPresenceFlip can target only relevant servers.
   */
  async registerWatchers(emails, serverId) {
    if (!emails || emails.length === 0) return;
    if (!serverId) return;

    const ttlSeconds = config.watchersTtlSeconds ?? 120;
    const pipeline = this.client.multi();

    for (const email of emails) {
      const normalized = this.normalizeEmail(email);
      if (!this.isValidEmail(normalized)) continue;
      const key = this.watchersKey(normalized);
      pipeline.sAdd(key, serverId);
      pipeline.expire(key, ttlSeconds);
    }

    await pipeline.exec();
  }

  /**
   * Unregister this WS server for these emails.
   * Called when the last local watcher for an email disappears.
   */
  async unregisterWatchers(emails, serverId) {
    if (!emails || emails.length === 0) return;
    if (!serverId) return;

    const pipeline = this.client.multi();
    for (const email of emails) {
      const normalized = this.normalizeEmail(email);
      if (!this.isValidEmail(normalized)) continue;
      pipeline.sRem(this.watchersKey(normalized), serverId);
    }
    await pipeline.exec();
  }

  // ---------------- Presence (TTL truth + ownership) ----------------
  /**
   * Set online with TTL. Value is serverId.
   * Returns { statusChanged, lastSeen } where statusChanged = offline -> online transition.
   */
  async setOnline(email, serverId) {
    const normalized = this.normalizeEmail(email);
    const key = this.presenceKey(normalized);

    // Pipeline to reduce round trips.
    const now = Date.now();
    const pipeline = this.client.multi();

    // Update "active" whenever user authenticates/comes online
    pipeline.set(this.activeKey(normalized), String(now));

    // SET ... GET returns previous value (null if absent)
    pipeline.set(key, serverId, {
      EX: config.presenceTtlSeconds,
      GET: true,
    });

    pipeline.get(this.lastSeenKey(normalized));

    const res = await pipeline.exec();

    const prev = res?.[1] ?? null;
    const lastSeenRaw = res?.[2] ?? null;

    return {
      statusChanged: prev === null,
      lastSeen: lastSeenRaw ? Number(lastSeenRaw) : null,
    };
  }

  /**
   * Refresh TTL only if this server still owns the key.
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
   * Optional optimization: mark offline early.
   * Only deletes if server still owns key.
   */
  async safeClearIfOwned(email, serverId) {
    const normalized = this.normalizeEmail(email);
    const key = this.presenceKey(normalized);

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

    return Number(res) === 1;
  }

  async isOnline(email) {
    const normalized = this.normalizeEmail(email);
    const serverId = await this.client.get(this.presenceKey(normalized));
    return Boolean(serverId);
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

  // ---------------- Batch reads for list (FAST) ----------------
  /**
   * Fetch presence for visible window / buffer.
   * Returns { email, online, lastActiveAt, bucket }.
   *
   * Call this from HTTP endpoint /presence/batch (or WS snapshot).
   */
  async getBatchPresenceForList(emails) {
    if (!emails || emails.length === 0) return [];

    const normalized = [];
    for (const e of emails) {
      const ne = this.normalizeEmail(e);
      if (ne && this.isValidEmail(ne)) normalized.push(ne);
    }
    if (normalized.length === 0) return [];

    const pipeline = this.client.multi();

    // GET presence value (serverId) to know online
    for (const email of normalized) pipeline.get(this.presenceKey(email));
    // GET lastActiveAt
    for (const email of normalized) pipeline.get(this.activeKey(email));

    const res = await pipeline.exec();
    const n = normalized.length;
    const now = Date.now();

    return normalized.map((email, i) => {
      const onlineServerId = res?.[i] ?? null;
      const lastActiveRaw = res?.[n + i] ?? null;

      const online = Boolean(onlineServerId);
      const lastActiveAt = lastActiveRaw ? Number(lastActiveRaw) : null;

      return {
        email,
        online,
        lastActiveAt,
        bucket: this.bucketize(now, lastActiveAt, online),
      };
    });
  }

  // ---------------- User registry (demo) ----------------
  usersKey() {
    return 'users:all';
  }

  async registerUser(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.sAdd(this.usersKey(), normalized);
  }

  async getAllUsers() {
    return await this.client.sMembers(this.usersKey());
  }
}

export const presenceService = new PresenceService();
