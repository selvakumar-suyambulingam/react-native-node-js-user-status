import { createClient } from 'redis';
import { config } from '../config.mjs';

export class PresenceService {
  client;
  pubClient;
  subClient;
  connected = false;
  presenceListeners = [];

  constructor() {
    this.client = createClient({
      url: config.redisUrl,
    });

    // Separate clients for pub/sub
    this.pubClient = createClient({
      url: config.redisUrl,
    });

    this.subClient = createClient({
      url: config.redisUrl,
    });

    this.client.on('error', (err) => {
      console.error('Redis error:', err);
    });

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
    if (!this.connected) {
      await this.client.connect();
      await this.pubClient.connect();
      await this.subClient.connect();

      // Subscribe to presence channel
      await this.subClient.subscribe('presence:updates', (message) => {
        const data = JSON.parse(message);
        this.presenceListeners.forEach(listener => listener(data));
      });

      // Enable keyspace notifications for expired keys
      await this.client.configSet('notify-keyspace-events', 'Ex');

      // Subscribe to expired keys for presence TTL
      await this.subClient.pSubscribe('__keyevent@0__:expired', async (key) => {
        if (key.startsWith('presence:')) {
          const email = key.replace('presence:', '');
          console.log(`User went offline due to TTL expiry: ${email}`);

          // Update last seen
          await this.updateLastSeen(email);

          // Publish offline event
          await this.publishPresenceUpdate(email, false);
        }
      });
    }
  }

  async disconnect() {
    if (this.connected) {
      await this.subClient.disconnect();
      await this.pubClient.disconnect();
      await this.client.disconnect();
    }
  }

  /**
   * Publish presence update to Redis Pub/Sub
   */
  async publishPresenceUpdate(email, online) {
    const message = JSON.stringify({ email, online, timestamp: Date.now() });
    await this.pubClient.publish('presence:updates', message);
  }

  /**
   * Register a listener for presence updates
   */
  onPresenceUpdate(callback) {
    this.presenceListeners.push(callback);
    return () => {
      this.presenceListeners = this.presenceListeners.filter(cb => cb !== callback);
    };
  }

  /**
   * Normalize email: trim and lowercase
   */
  normalizeEmail(email) {
    return email.trim().toLowerCase();
  }

  /**
   * Validate email format (must contain @)
   */
  isValidEmail(email) {
    return email.includes('@');
  }

  /**
   * Add user to the registered users set
   */
  async registerUser(email) {
    const normalized = this.normalizeEmail(email);
    await this.client.sAdd('users:all', normalized);
  }

  /**
   * Get all registered users
   */
  async getAllUsers() {
    const users = await this.client.sMembers('users:all');
    return users;
  }

  /**
   * Set user as online (with TTL) and return whether status changed
   * Returns true if user was offline and is now online (status changed)
   * Returns false if user was already online (no change)
   */
  async setOnline(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;

    // Check if user was already online
    const wasOnline = await this.client.exists(key);

    // Set online with TTL
    await this.client.set(key, '1', {
      EX: config.presenceTtlSeconds,
    });

    // Return true if status changed (was offline, now online)
    return wasOnline === 0;
  }

  /**
   * Store last seen timestamp for user
   */
  async updateLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    const key = `lastseen:${normalized}`;
    await this.client.set(key, Date.now().toString());
  }

  /**
   * Get last seen timestamp for user
   */
  async getLastSeen(email) {
    const normalized = this.normalizeEmail(email);
    const key = `lastseen:${normalized}`;
    const timestamp = await this.client.get(key);
    return timestamp ? parseInt(timestamp, 10) : null;
  }

  /**
   * Refresh user presence TTL
   */
  async refreshPresence(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.expire(key, config.presenceTtlSeconds);
  }

  /**
   * Check if user is online
   */
  async isOnline(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    const exists = await this.client.exists(key);
    return exists === 1;
  }

  /**
   * Increment connection count for user
   * Returns the new connection count
   */
  async incrementConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const key = `connections:${normalized}`;
    return await this.client.incr(key);
  }

  /**
   * Decrement connection count for user
   * Returns the new connection count
   */
  async decrementConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const key = `connections:${normalized}`;
    const count = await this.client.decr(key);

    // Clean up if count reaches 0
    if (count <= 0) {
      await this.client.del(key);
    }

    return Math.max(0, count);
  }

  /**
   * Get connection count for user
   */
  async getConnectionCount(email) {
    const normalized = this.normalizeEmail(email);
    const key = `connections:${normalized}`;
    const count = await this.client.get(key);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Set user as offline (delete presence key) and update last seen
   * Only sets offline if no more connections exist
   */
  async setOffline(email) {
    const normalized = this.normalizeEmail(email);

    // Update last seen timestamp
    await this.updateLastSeen(normalized);

    // Check if there are still active connections
    const connectionCount = await this.getConnectionCount(normalized);

    // Only set offline if no connections remain
    if (connectionCount === 0) {
      const key = `presence:${normalized}`;
      await this.client.del(key);
      return true; // Status changed to offline
    }

    return false; // Still has connections, remains online
  }

  /**
   * Get all users with their online status and last seen timestamp
   */
  async getUsersWithStatus() {
    const users = await this.getAllUsers();
    const usersWithStatus = await Promise.all(
      users.map(async (email) => {
        const online = await this.isOnline(email);
        const lastSeen = await this.getLastSeen(email);
        const connectionCount = await this.getConnectionCount(email);

        return {
          email,
          online,
          lastSeen,
          connectionCount,
        };
      })
    );
    return usersWithStatus;
  }
}

// Singleton instance
export const presenceService = new PresenceService();
