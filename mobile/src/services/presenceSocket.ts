import { config } from '../config';

interface PresenceSocketCallbacks {
  onPresenceUpdate?: (email: string, online: boolean) => void;
  onAuthSuccess?: (email: string, heartbeatMs: number, ttlSeconds: number) => void;
  onError?: (error: string) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class PresenceSocket {
  private ws: WebSocket | null = null;
  private email: string | null = null;
  private heartbeatIntervalId: number | null = null;
  private heartbeatMs: number = config.heartbeatIntervalMs;
  private callbacks: PresenceSocketCallbacks;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(callbacks: PresenceSocketCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Connect to WebSocket server and authenticate
   */
  connect(email: string) {
    if (this.ws) {
      console.log('Already connected, disconnecting first');
      this.disconnect();
    }

    this.email = email;
    const wsUrl = `${config.wsBaseUrl}/ws`;

    console.log(`Connecting to WebSocket: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.callbacks.onConnectionChange?.(true);

        // Send auth message
        this.send({
          type: 'auth',
          email: this.email,
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.callbacks.onError?.('WebSocket error');
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.callbacks.onConnectionChange?.(false);
        this.stopHeartbeat();

        // Attempt to reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            if (this.email) {
              this.connect(this.email);
            }
          }, 2000);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      this.callbacks.onError?.('Failed to create WebSocket connection');
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    console.log('Disconnecting WebSocket');
    this.stopHeartbeat();
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.email = null;
  }

  /**
   * Send a message to the server
   */
  private send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not open, cannot send message');
    }
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: any) {
    console.log('Received message:', message);

    switch (message.type) {
      case 'auth:ok':
        this.handleAuthSuccess(message);
        break;

      case 'presence:update':
        this.handlePresenceUpdate(message);
        break;

      case 'pong':
        // Heartbeat acknowledged
        break;

      case 'error':
        console.error('Server error:', message.message);
        this.callbacks.onError?.(message.message);
        break;

      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  /**
   * Handle successful authentication
   */
  private handleAuthSuccess(message: any) {
    const { email, heartbeatMs, ttlSeconds } = message;
    console.log(`Authenticated as ${email}, heartbeat: ${heartbeatMs}ms, TTL: ${ttlSeconds}s`);

    this.heartbeatMs = heartbeatMs;
    this.startHeartbeat();

    this.callbacks.onAuthSuccess?.(email, heartbeatMs, ttlSeconds);
  }

  /**
   * Handle presence update
   */
  private handlePresenceUpdate(message: any) {
    const { email, online } = message;
    console.log(`Presence update: ${email} -> ${online ? 'ONLINE' : 'OFFLINE'}`);

    this.callbacks.onPresenceUpdate?.(email, online);
  }

  /**
   * Start sending heartbeat pings
   */
  private startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatIntervalId = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.heartbeatMs) as unknown as number;

    console.log(`Started heartbeat (${this.heartbeatMs}ms)`);
  }

  /**
   * Stop sending heartbeat pings
   */
  private stopHeartbeat() {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
      console.log('Stopped heartbeat');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
