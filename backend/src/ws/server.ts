import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { presenceService } from '../services/presence';
import { config } from '../config';

interface AuthenticatedWebSocket extends WebSocket {
  email?: string;
  isAlive?: boolean;
}

interface WSMessage {
  type: string;
  email?: string;
  [key: string]: any;
}

export class PresenceWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<string, AuthenticatedWebSocket> = new Map();

  constructor(server: any) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', this.handleConnection.bind(this));

    console.log('WebSocket server initialized on /ws');
  }

  private handleConnection(ws: AuthenticatedWebSocket, req: IncomingMessage) {
    console.log('New WebSocket connection');

    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
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

  private async handleMessage(ws: AuthenticatedWebSocket, message: WSMessage) {
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

  private async handleAuth(ws: AuthenticatedWebSocket, message: WSMessage) {
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

  private async handlePing(ws: AuthenticatedWebSocket) {
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
  broadcastPresenceUpdate(email: string, online: boolean) {
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
  getConnectedEmails(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Start periodic ping to check for dead connections
   */
  startHeartbeatCheck() {
    const interval = 30000; // 30 seconds
    setInterval(() => {
      this.wss.clients.forEach((ws: AuthenticatedWebSocket) => {
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
