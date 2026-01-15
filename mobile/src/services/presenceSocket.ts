import { config } from '../config';

interface PresenceStatus {
  email: string;
  online: boolean;
}

interface PresenceSocketCallbacks {
  onPresenceUpdate?: (email: string, online: boolean) => void;
  onAuthSuccess?: (email: string, heartbeatMs: number, ttlSeconds: number) => void;
  onSubscribeSuccess?: (statuses: PresenceStatus[]) => void;
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

  // Track subscribed users for resubscription on reconnect
  private subscribedUsers: Set<string> = new Set();

  // Queue subscriptions if not yet authenticated
  private pendingSubscriptions: string[] = [];
  private isAuthenticated: boolean = false;

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
    this.isAuthenticated = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.email = null;
  }

  /**
   * Subscribe to presence updates for specific users.
   * Call this after authentication with the user's contact list.
   * This is the key to scalability - only receive updates for users you care about.
   */
  subscribeToUsers(emails: string[]) {
    if (emails.length === 0) return;

    // Filter out already subscribed users
    const newEmails = emails.filter((e) => !this.subscribedUsers.has(e.toLowerCase()));
    if (newEmails.length === 0) return;

    // If not yet authenticated, queue for later
    if (!this.isAuthenticated || !this.isConnected()) {
      console.log('Not authenticated yet, queuing subscriptions');
      this.pendingSubscriptions.push(...newEmails);
      return;
    }

    this.send({
      type: 'subscribe',
      emails: newEmails,
    });

    // Add to tracked set
    newEmails.forEach((e) => this.subscribedUsers.add(e.toLowerCase()));
  }

  /**
   * Unsubscribe from specific users' presence updates.
   * Call this when users are removed from contacts or no longer needed.
   */
  unsubscribeFromUsers(emails: string[]) {
    if (emails.length === 0) return;

    const toRemove = emails.filter((e) => this.subscribedUsers.has(e.toLowerCase()));
    if (toRemove.length === 0) return;

    if (this.isConnected()) {
      this.send({
        type: 'unsubscribe',
        emails: toRemove,
      });
    }

    toRemove.forEach((e) => this.subscribedUsers.delete(e.toLowerCase()));
  }

  /**
   * Get list of currently subscribed users
   */
  getSubscribedUsers(): string[] {
    return Array.from(this.subscribedUsers);
  }

  /**
   * Clear all subscriptions
   */
  clearSubscriptions() {
    if (this.subscribedUsers.size > 0 && this.isConnected()) {
      this.send({
        type: 'unsubscribe',
        emails: Array.from(this.subscribedUsers),
      });
    }
    this.subscribedUsers.clear();
    this.pendingSubscriptions = [];
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

      case 'subscribe:ok':
        this.handleSubscribeSuccess(message);
        break;

      case 'unsubscribe:ok':
        // Unsubscription confirmed
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
    this.isAuthenticated = true;
    this.startHeartbeat();

    this.callbacks.onAuthSuccess?.(email, heartbeatMs, ttlSeconds);

    // Resubscribe to previously subscribed users on reconnect
    if (this.subscribedUsers.size > 0) {
      console.log(`Resubscribing to ${this.subscribedUsers.size} users after reconnect`);
      this.send({
        type: 'subscribe',
        emails: Array.from(this.subscribedUsers),
      });
    }

    // Process any pending subscriptions that were queued before auth
    if (this.pendingSubscriptions.length > 0) {
      console.log(`Processing ${this.pendingSubscriptions.length} pending subscriptions`);
      const pending = [...this.pendingSubscriptions];
      this.pendingSubscriptions = [];
      this.subscribeToUsers(pending);
    }
  }

  /**
   * Handle subscription success - receives initial presence status
   */
  private handleSubscribeSuccess(message: any) {
    const { statuses } = message;
    console.log(`Subscription confirmed, received ${statuses?.length || 0} statuses`);

    // Notify callback with the statuses
    if (this.callbacks.onSubscribeSuccess) {
      this.callbacks.onSubscribeSuccess(statuses || []);
    }

    // Also trigger individual presence updates for each status
    if (statuses && Array.isArray(statuses)) {
      for (const { email, online } of statuses) {
        this.callbacks.onPresenceUpdate?.(email, online);
      }
    }
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
