import { createClient } from 'redis';
import { config } from '../config.mjs';

export class PresenceService {
  client;
  pubClient;
  //subClient;
  connected = false;
  presenceListeners = [];

  constructor() {
    this.client = createClient({ url: config.redisUrl });
    this.pubClient = createClient({ url: config.redisUrl });
    //this.subClient = createClient({ url: config.redisUrl });

    this.client.on('error', (err) => console.error('Redis error:', err));
    this.client.on('connect', () => {
      console.log('Connected to Redis');
      this.connected = true;
    });
    this.client.on('disconnect', () => {
      console.log('Disconnected from Redis');
      this.connected = false;
    });
  }

  async connect() {
    if (this.connected) return;

    await this.client.connect();
    await this.pubClient.connect();
    //await this.subClient.connect();

    // Pub/Sub for cross-instance updates
    /*await this.subClient.subscribe('presence:updates', (message) => {
      const data = JSON.parse(message);
      this.presenceListeners.forEach((listener) => listener(data));
    });*/

    // IMPORTANT:
    // No keyspace notifications, no configSet, no expired subscriptions.
    // Offline is determined by TTL expiry naturally (presence key disappears).
  }

  async disconnect() {
    if (!this.connected) return;
    await this.subClient.disconnect();
    await this.pubClient.disconnect();
    await this.client.disconnect();
  }

  async publishPresenceUpdate(email, online) {
    const message = JSON.stringify({ email, online, timestamp: Date.now() });
    await this.pubClient.publish('presence:updates', message);
  }

  /*onPresenceUpdate(callback) {
    this.presenceListeners.push(callback);
    return () => {
      this.presenceListeners = this.presenceListeners.filter((cb) => cb !== callback);
    };
  }*/

  normalizeEmail(email) {
    return email.trim().toLowerCase();
  }

  isValidEmail(email) {
    // Simple but better than includes('@')
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ---------- Presence (TTL truth) ----------
  async setOnline(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;

    const wasOnline = await this.client.exists(key);

    // Store tiny value + TTL
    await this.client.set(key, '1', { EX: config.presenceTtlSeconds });

    return wasOnline === 0;
  }

  async refreshPresence(email) {
    const normalized = this.normalizeEmail(email);

    // Refresh both presence + connections TTL so crash can’t keep stale count forever
    const presenceKey = `presence:${normalized}`;
    const connectionsKey = `connections:${normalized}`;

    // Using MULTI cuts RTTs
    await this.client
      .multi()
      .expire(presenceKey, config.presenceTtlSeconds)
      .expire(connectionsKey, config.presenceTtlSeconds)
      .exec();
  }

  async isOnline(email) {
    const normalized = this.normalizeEmail(email);
    const exists = await this.client.exists(`presence:${normalized}`);
    return exists === 1;
  }

  // ---------- Last seen ----------
  async updateLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.set(`lastseen:${normalized}`, Date.now().toString());
  }

  async getLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    const ts = await this.client.get(`lastseen:${normalized}`);
    return ts ? parseInt(ts, 10) : null;
  }

  // ---------- Crash-safe connection count ----------
  async incrementConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const key = `connections:${normalized}`;

    const res = await this.client
      .multi()
      .incr(key)
      .expire(key, config.presenceTtlSeconds)
      .exec();

    // node-redis returns array of results; INCR result is first command
    const newCount = Number(res?.[0]);
    return Number.isFinite(newCount) ? newCount : 1;
  }

  async decrementConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const key = `connections:${normalized}`;

    const count = await this.client.decr(key);

    // If it goes <= 0, cleanup
    if (count <= 0) {
      await this.client.del(key);
      return 0;
    }

    // Keep it crash-safe: refresh TTL on decrement too
    await this.client.expire(key, config.presenceTtlSeconds);
    return count;
  }

  async getConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const val = await this.client.get(`connections:${normalized}`);
    return val ? parseInt(val, 10) : 0;
  }

  async setOffline(email) {
    const normalized = this.normalizeEmail(email);

    await this.updateLastSeen(normalized);

    // Only set offline if no connections remain
    const count = await this.getConnectionCount(normalized);
    if (count === 0) {
      await this.client.del(`presence:${normalized}`);
      return true;
    }
    return false;
  }

  // Optional helpers you already have:
  async registerUser(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.sAdd('users:all', normalized);
  }

  async getAllUsers() {
    return await this.client.sMembers('users:all');
  }

  async getUsersWithStatus() {
    const users = await this.getAllUsers();
    return await Promise.all(
      users.map(async (email) => ({
        email,
        online: await this.isOnline(email),
        lastSeen: await this.getLastSeen(email),
        connectionCount: await this.getConnectionCount(email),
      }))
    );
  }
}

export const presenceService = new PresenceService();
