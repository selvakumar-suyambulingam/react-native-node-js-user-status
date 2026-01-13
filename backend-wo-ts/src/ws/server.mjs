import { WebSocketServer, WebSocket } from 'ws';
import { presenceService } from '../services/presence.mjs';
import { config } from '../config.mjs';

export class PresenceWebSocketServer {
  wss;
  clients = new Map();

  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));

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
        this.clients.delete(ws.email);
        // Best-effort offline broadcast on clean close
        await presenceService.setOffline(ws.email);
        this.broadcastPresenceUpdate(ws.email, false);
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

    // Authenticate and set online
    ws.email = normalized;
    this.clients.set(normalized, ws);

    await presenceService.setOnline(normalized);

    console.log(`User authenticated via WebSocket: ${normalized}`);

    // Send auth confirmation
    ws.send(JSON.stringify({
      type: 'auth:ok',
      email: normalized,
      heartbeatMs: config.heartbeatIntervalMs,
      ttlSeconds: config.presenceTtlSeconds,
    }));

    // Broadcast online status to all clients
    this.broadcastPresenceUpdate(normalized, true);
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
   * Broadcast presence update to all connected clients
   */
  broadcastPresenceUpdate(email, online) {
    const message = JSON.stringify({
      type: 'presence:update',
      email,
      online,
    });

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });

    console.log(`Broadcasted presence update: ${email} -> ${online ? 'ONLINE' : 'OFFLINE'}`);
  }

  /**
   * Get all currently connected clients
   */
  getConnectedEmails() {
    return Array.from(this.clients.keys());
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
