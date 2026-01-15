import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10),
  presenceTtlSeconds: parseInt(process.env.PRESENCE_TTL_SECONDS || '90', 10),

  // Unique server ID for multi-server deployments
  // Use stable ID from env for production, random for dev
  serverId: process.env.SERVER_ID || crypto.randomUUID(),

  // Subscription limits to prevent abuse
  maxSubscriptionsPerClient: parseInt(process.env.MAX_SUBSCRIPTIONS_PER_CLIENT || '500', 10),

  // Watcher TTL - auto-cleanup stale server subscriptions
  watcherTtlSeconds: parseInt(process.env.WATCHER_TTL_SECONDS || '3600', 10),

  // Pub/Sub channel name
  presenceChannel: process.env.PRESENCE_CHANNEL || 'presence:updates',

  // Rate limiting
  maxConnectionsPerIp: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '10', 10),
  subscribeRateLimitPerMinute: parseInt(process.env.SUBSCRIBE_RATE_LIMIT || '60', 10)
};
