import { presenceService } from '../services/presence.mjs';
import { PresenceWebSocketServer } from './server.mjs';
import { config } from '../config.mjs';

/**
 * Presence Sweeper
 *
 * Periodically checks for users who have gone offline due to TTL expiry.
 * Maintains an in-memory map of email -> lastKnownOnline status.
 * When a user transitions from online to offline, broadcasts the update.
 */
export class PresenceSweeper {
  wsServer;
  lastKnownStatus = new Map();
  intervalId;

  constructor(wsServer) {
    this.wsServer = wsServer;
  }

  /**
   * Start the sweeper
   */
  start() {
    console.log(`Starting presence sweeper (interval: ${config.sweeperIntervalMs}ms)`);

    this.intervalId = setInterval(async () => {
      await this.checkPresenceChanges();
    }, config.sweeperIntervalMs);
  }

  /**
   * Stop the sweeper
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('Presence sweeper stopped');
    }
  }

  /**
   * Check for presence changes and broadcast updates
   */
  async checkPresenceChanges() {
    try {
      const users = await presenceService.getAllUsers();

      for (const email of users) {
        const currentOnline = await presenceService.isOnline(email);
        const lastKnown = this.lastKnownStatus.get(email);

        // Detect transition from online to offline
        if (lastKnown === true && currentOnline === false) {
          console.log(`Detected offline transition: ${email}`);
          this.wsServer.broadcastPresenceUpdate(email, false);
        }

        // Detect transition from offline to online (or first time seeing this user)
        if ((lastKnown === false || lastKnown === undefined) && currentOnline === true) {
          console.log(`Detected online transition: ${email}`);
          // Note: online transitions are usually handled by handleAuth, but this catches edge cases
        }

        // Update last known status
        this.lastKnownStatus.set(email, currentOnline);
      }
    } catch (error) {
      console.error('Error in presence sweeper:', error);
    }
  }
}
