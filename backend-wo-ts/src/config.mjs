import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Heartbeat: no need to be super aggressive. 30-60s is typical.
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '45000', 10),

  // Presence TTL should be > heartbeat (2x is a decent start)
  presenceTtlSeconds: parseInt(process.env.PRESENCE_TTL_SECONDS || '120', 10),

  // Unique server ID for multi-server deployments
  serverId: process.env.SERVER_ID || crypto.randomUUID(),

  // ---- Focus/Blur (realtime window) ----
  // Cap realtime per socket. Visible list is ~8, buffer maybe 50, open chat 1 => 100 is safe.
  maxFocusPerClient: parseInt(process.env.MAX_FOCUS_PER_CLIENT || '100', 10),

  // Rate limiting focus calls
  focusRateLimitPerMinute: parseInt(process.env.FOCUS_RATE_LIMIT_PER_MINUTE || '60', 10),

  // ---- Pub/Sub flip shards ----
  // Local: set to 1. Prod: 32/64.
  presenceShardCount: parseInt(process.env.PRESENCE_SHARD_COUNT || '1', 10),

  // (Optional) keep your legacy channel if you still have old code paths
  presenceChannel: process.env.PRESENCE_CHANNEL || 'presence:updates',

  // Connection rate limiting
  maxConnectionsPerIp: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '10', 10),
};
