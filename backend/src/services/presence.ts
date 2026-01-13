import { createClient, RedisClientType } from 'redis';
import { config } from '../config';

export class PresenceService {
  private client: RedisClientType;
  private connected: boolean = false;

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

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.disconnect();
    }
  }

  /**
   * Normalize email: trim and lowercase
   */
  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Validate email format (must contain @)
   */
  isValidEmail(email: string): boolean {
    return email.includes('@');
  }

  /**
   * Add user to the registered users set
   */
  async registerUser(email: string): Promise<void> {
    const normalized = this.normalizeEmail(email);
    await this.client.sAdd('users:all', normalized);
  }

  /**
   * Get all registered users
   */
  async getAllUsers(): Promise<string[]> {
    const users = await this.client.sMembers('users:all');
    return users;
  }

  /**
   * Set user as online (with TTL)
   */
  async setOnline(email: string): Promise<void> {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.set(key, '1', {
      EX: config.presenceTtlSeconds,
    });
  }

  /**
   * Refresh user presence TTL
   */
  async refreshPresence(email: string): Promise<void> {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.expire(key, config.presenceTtlSeconds);
  }

  /**
   * Check if user is online
   */
  async isOnline(email: string): Promise<boolean> {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    const exists = await this.client.exists(key);
    return exists === 1;
  }

  /**
   * Set user as offline (delete presence key)
   */
  async setOffline(email: string): Promise<void> {
    const normalized = this.normalizeEmail(email);
    const key = `presence:${normalized}`;
    await this.client.del(key);
  }

  /**
   * Get all users with their online status
   */
  async getUsersWithStatus(): Promise<Array<{ email: string; online: boolean }>> {
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
