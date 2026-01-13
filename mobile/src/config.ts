/**
 * Configuration for the mobile app
 *
 * IMPORTANT: Update these URLs with your computer's local IP address.
 * Find your IP:
 *   - Windows: Open CMD and run `ipconfig`, look for IPv4 Address
 *   - Mac/Linux: Run `ifconfig` or `ip addr`
 *
 * DO NOT use localhost or 127.0.0.1 when running on a physical device or emulator,
 * as they will refer to the device itself, not your development machine.
 */

// Update this to your computer's local IP address
const HOST = 'localhost'; // CHANGE THIS
const PORT = '3000';

export const config = {
  apiBaseUrl: `http://${HOST}:${PORT}`,
  wsBaseUrl: `ws://${HOST}:${PORT}`,
  heartbeatIntervalMs: 15000, // Will be overridden by server
};
