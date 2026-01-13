import { createClient } from 'redis';
import { config } from '../config.mjs';

export class PresenceService {
  client;
  connected = false;

  constructor() {
    this.client = createClient({
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
    }
  }

  async disconnect() {
    if (this.connected) {
      await this.client.disconnect();
    }
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
   * Set user as online (with TTL)
   */
  async setOnline(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.set(key, '1', {
      EX: config.presenceTtlSeconds,
    });
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
   * Set user as offline (delete presence key)
   */
  async setOffline(email) {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.del(key);
  }

  /**
   * Get all users with their online status
   */
  async getUsersWithStatus() {
    const users = await this.getAllUsers();
    const usersWithStatus = await Promise.all(
      users.map(async (email) => ({
        email,
        online: await this.isOnline(email),
      }))
    );
    return usersWithStatus;
  }
}

// Singleton instance
export const presenceService = new PresenceService();
