import { WebSocketServer, WebSocket } from 'ws';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;
  clients = new Map(); // email -> Set of WebSocket connections

  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));

    // Listen for presence updates from Redis (other server instances or TTL expiry)
    presenceService.onPresenceUpdate((data) => {
      console.log(`Received presence update from Redis: ${data.email} -> ${data.online ? 'ONLINE' : 'OFFLINE'}`);
      this.broadcastPresenceUpdate(data.email, data.online);
    });

    console.log('WebSocket server initialized on /ws');
  }

  handleConnection(ws, req) {
    console.log('New WebSocket connection');

    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    ws.on('close', async () => {
      console.log(`WebSocket closed for: ${ws.email || 'unknown'}`);
      if (ws.email) {
        // Remove this specific connection from the user's connection set
        const connections = this.clients.get(ws.email);
        if (connections) {
          connections.delete(ws);

          // If no more connections for this user, remove from map
          if (connections.size === 0) {
            this.clients.delete(ws.email);
          }
        }

        // Decrement connection count in Redis
        const remainingConnections = await presenceService.decrementConnectionCount(ws.email);
        console.log(`Remaining connections for ${ws.email}: ${remainingConnections}`);

        // Only mark offline and broadcast if this was the last connection
        if (remainingConnections === 0) {
          const statusChanged = await presenceService.setOffline(ws.email);

          if (statusChanged) {
            // Publish to Redis (will be received by all server instances)
            await presenceService.publishPresenceUpdate(ws.email, false);
          }
        }
      }
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

      case 'ping':
        await this.handlePing(ws);
        break;

      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type',
        }));
    }
  }

  async handleAuth(ws, message) {
    const { email } = message;

    if (!email || typeof email !== 'string') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Email is required',
      }));
      return;
    }

    const normalized = presenceService.normalizeEmail(email);

    if (!presenceService.isValidEmail(normalized)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid email format',
      }));
      return;
    }

    // Authenticate and track connection
    ws.email = normalized;

    // Add connection to the set for this user
    if (!this.clients.has(normalized)) {
      this.clients.set(normalized, new Set());
    }
    this.clients.get(normalized).add(ws);

    // Increment connection count in Redis
    const connectionCount = await presenceService.incrementConnectionCount(normalized);
    console.log(`User authenticated via WebSocket: ${normalized} (${connectionCount} connection${connectionCount > 1 ? 's' : ''})`);

    // Set online and check if status changed (was offline, now online)
    const statusChanged = await presenceService.setOnline(normalized);

    // Send auth confirmation with last seen info
    const lastSeen = await presenceService.getLastSeen(normalized);
    ws.send(JSON.stringify({
      type: 'auth:ok',
      email: normalized,
      heartbeatMs: config.heartbeatIntervalMs,
      ttlSeconds: config.presenceTtlSeconds,
      lastSeen,
      connectionCount,
    }));

    // Only broadcast if status actually changed (user was offline, now online)
    if (statusChanged) {
      console.log(`Status changed for ${normalized}: offline -> online`);
      // Publish to Redis (will be received by all server instances)
      await presenceService.publishPresenceUpdate(normalized, true);
    } else {
      console.log(`User ${normalized} reconnected (already online, no broadcast)`);
    }
  }

  async handlePing(ws) {
    if (!ws.email) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated',
      }));
      return;
    }

    // Refresh presence TTL
    await presenceService.refreshPresence(ws.email);

    // Optional: send pong response
    ws.send(JSON.stringify({
      type: 'pong',
    }));
  }

  /**
   * Broadcast presence update to all connected clients on this server instance
   */
  broadcastPresenceUpdate(email, online) {
    const message = JSON.stringify({
      type: 'presence:update',
      email,
      online,
      timestamp: Date.now(),
    });

    let sentCount = 0;

    // Iterate through all users and their connections
    this.clients.forEach((connections, userEmail) => {
      connections.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          sentCount++;
        }
      });
    });

    console.log(`Broadcasted presence update to ${sentCount} connection(s): ${email} -> ${online ? 'ONLINE' : 'OFFLINE'}`);
  }

  /**
   * Get all currently connected user emails on this server instance
   */
  getConnectedEmails() {
    return Array.from(this.clients.keys());
  }

  /**
   * Get total number of connections across all users on this server instance
   */
  getTotalConnections() {
    let total = 0;
    this.clients.forEach((connections) => {
      total += connections.size;
    });
    return total;
  }

  /**
   * Start periodic ping to check for dead connections
   */
  startHeartbeatCheck() {
    const interval = 30000; // 30 seconds
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log(`Terminating dead connection for: ${ws.email || 'unknown'}`);
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, interval);
  }
}
