# WebSocket User Presence Tracker

A complete monorepo demonstrating real-time user presence tracking with WebSocket, Redis TTL, and React Native.

## Features

- **Real-time presence tracking** using WebSockets (ws library, not Socket.IO)
- **Redis TTL-based offline detection** - users go offline when heartbeat stops
- **Automatic presence sweeper** - detects TTL expiry and broadcasts offline updates
- **No password authentication** - login with email only
- **React Native (Expo)** frontend with live status updates
- **Clean architecture** - separate modules for routes, services, and WebSocket handling
- **TypeScript** backend and frontend

## Architecture

### Backend (Node.js + Express + ws + Redis)
- **REST API**: Login and user list endpoints
- **WebSocket Server**: Authentication, heartbeat, and presence broadcasting
- **Redis**: User registry and TTL-based presence tracking
- **Presence Sweeper**: Detects offline transitions when TTL expires

### Frontend (React Native + Expo)
- **Login Screen**: Email-only authentication
- **User List**: Real-time online/offline status
- **WebSocket Client**: Automatic connection and heartbeat management

### Redis Data Model
- `users:all` (SET) - All registered user emails
- `presence:{email}` (STRING) - Value "1" with TTL (45 seconds)
- **Online rule**: `EXISTS presence:{email} == 1`
- **Offline rule**: Key missing

### WebSocket Protocol
1. Client connects and sends: `{ "type": "auth", "email": "user@example.com" }`
2. Server responds: `{ "type": "auth:ok", "email": "...", "heartbeatMs": 15000, "ttlSeconds": 45 }`
3. Client sends heartbeat every 15 seconds: `{ "type": "ping" }`
4. Server broadcasts presence updates: `{ "type": "presence:update", "email": "...", "online": true/false }`

## Prerequisites

- **Node.js 20+** - [Download](https://nodejs.org/)
- **Redis** - See installation instructions below
- **Expo CLI** - Installed automatically with the mobile app
- **Physical device or emulator** for React Native

## Redis Installation (Windows)

### Option 1: Redis via WSL (Recommended)

1. **Install WSL 2** (if not already installed):
   ```bash
   wsl --install
   ```
   Restart your computer if prompted.

2. **Install Redis in WSL**:
   ```bash
   wsl
   sudo apt update
   sudo apt install redis-server
   ```

3. **Start Redis**:
   ```bash
   sudo service redis-server start
   ```

4. **Verify Redis is running**:
   ```bash
   redis-cli ping
   # Should return: PONG
   ```

5. **Keep WSL running** while developing. Redis will be accessible at `redis://localhost:6379`.

### Option 2: Redis via Memurai (Windows Native)

1. Download Memurai (Redis-compatible): [https://www.memurai.com/get-memurai](https://www.memurai.com/get-memurai)
2. Install and start Memurai
3. Redis will be available at `redis://localhost:6379`

## Installation & Setup

### 1. Clone the Repository

```bash
cd C:\github\react-native-node-js-user-status
```

### 2. Backend Setup

```bash
cd backend
npm install
```

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Default configuration:
```env
PORT=3000
REDIS_URL=redis://localhost:6379
HEARTBEAT_INTERVAL_MS=15000
PRESENCE_TTL_SECONDS=45
SWEEPER_INTERVAL_MS=5000
```

### 3. Mobile App Setup

```bash
cd ../mobile
npm install
```

**IMPORTANT**: Update the backend host IP in `mobile/src/config.ts`:

1. Find your computer's local IP address:
   - Open Command Prompt
   - Run: `ipconfig`
   - Look for "IPv4 Address" (e.g., `192.168.1.100`)

2. Edit `mobile/src/config.ts`:
   ```typescript
   const HOST = '192.168.1.100'; // Replace with YOUR IP
   ```

**Why not use localhost?** When running the app on a physical device or emulator, `localhost` refers to the device itself, not your development machine.

## Running the Application

### 1. Start Redis

**WSL**:
```bash
wsl
sudo service redis-server start
```

**Memurai**: Should start automatically, or start from the Memurai app.

### 2. Start Backend

```bash
cd backend
npm run dev
```

You should see:
```
Connected to Redis
==================================================
Server running on port 3000
REST API: http://localhost:3000
WebSocket: ws://localhost:3000/ws
Heartbeat interval: 15000ms
Presence TTL: 45s
Sweeper interval: 5000ms
==================================================
```

### 3. Start Mobile App

```bash
cd mobile
npx expo start
```

This will open the Expo DevTools in your browser.

**Run on device**:
- Scan the QR code with the Expo Go app (iOS/Android)
- Make sure your device is on the same WiFi network as your computer

**Run on emulator**:
- Press `a` for Android emulator
- Press `i` for iOS simulator (macOS only)

## Testing the Application

### Single User Test

1. Start Redis and backend (see above)
2. Launch the mobile app
3. Enter an email (e.g., `alice@test.com`) and tap "Login"
4. You should see yourself in the user list with status "ONLINE"
5. The connection indicator should show "Connected"

### Two User Test (Testing Real-time Presence)

#### Option 1: Two Physical Devices
1. Install Expo Go on both devices
2. Connect both to the same WiFi network
3. Scan the Expo QR code on both devices
4. Login as `alice@test.com` on device 1
5. Login as `bob@test.com` on device 2
6. Both devices should show both users as ONLINE

#### Option 2: Physical Device + Web
1. Run on device: `npx expo start` (scan QR)
2. In another terminal: `npx expo start --web`
3. Login as different users on each

#### Option 3: Two Emulators (Android)
1. Start two Android emulators
2. On first: `npx expo start` and press `a`
3. On second: Run `adb devices` to get device IDs
4. `npx expo start --android --device <device-id>`

### Testing Offline Detection

1. Have two users connected (Alice and Bob)
2. On Bob's device, close the app completely (swipe away)
3. Wait 45 seconds (TTL) + 5 seconds (sweeper interval) = ~50 seconds
4. On Alice's device, Bob should automatically show as OFFLINE
5. Reopen the app on Bob's device and login again
6. Alice should see Bob go ONLINE immediately

## API Reference

### REST API

#### POST /login
Authenticate user (no password required)

**Request**:
```json
{
  "email": "user@example.com"
}
```

**Response**:
```json
{
  "ok": true,
  "email": "user@example.com"
}
```

#### GET /users
Get all users with their online status

**Response**:
```json
{
  "users": [
    { "email": "alice@test.com", "online": true },
    { "email": "bob@test.com", "online": false }
  ]
}
```

### WebSocket Messages

#### Client → Server

**Authentication**:
```json
{
  "type": "auth",
  "email": "user@example.com"
}
```

**Heartbeat**:
```json
{
  "type": "ping"
}
```

#### Server → Client

**Auth Success**:
```json
{
  "type": "auth:ok",
  "email": "user@example.com",
  "heartbeatMs": 15000,
  "ttlSeconds": 45
}
```

**Presence Update**:
```json
{
  "type": "presence:update",
  "email": "user@example.com",
  "online": true
}
```

## Project Structure

```
react-native-node-js-user-status/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Bootstrap server
│   │   ├── config.ts             # Configuration
│   │   ├── routes/
│   │   │   ├── auth.ts           # POST /login
│   │   │   └── users.ts          # GET /users
│   │   ├── services/
│   │   │   └── presence.ts       # Redis operations
│   │   └── ws/
│   │       ├── server.ts         # WebSocket server
│   │       └── sweeper.ts        # Offline detection
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── mobile/
│   ├── src/
│   │   ├── config.ts             # API/WS URLs
│   │   ├── screens/
│   │   │   └── Home.tsx          # Main UI
│   │   └── services/
│   │       ├── api.ts            # REST client
│   │       └── presenceSocket.ts # WebSocket client
│   ├── App.tsx
│   ├── index.js
│   ├── package.json
│   └── app.json
└── README.md
```

## Environment Variables

### Backend (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `HEARTBEAT_INTERVAL_MS` | `15000` | Heartbeat interval (15s) |
| `PRESENCE_TTL_SECONDS` | `45` | Presence key TTL (45s) |
| `SWEEPER_INTERVAL_MS` | `5000` | Sweeper check interval (5s) |

### Mobile (src/config.ts)

| Variable | Description |
|----------|-------------|
| `HOST` | Your computer's local IP address |
| `PORT` | Backend port (should match backend) |

## How It Works

### Online Detection
1. Client connects to WebSocket and authenticates
2. Server creates `presence:{email}` key in Redis with 45s TTL
3. Client sends heartbeat every 15s
4. Server refreshes TTL on each heartbeat
5. As long as heartbeats arrive, user stays online

### Offline Detection
1. Client stops sending heartbeats (app closed/network lost)
2. Redis TTL expires after 45s (3x heartbeat interval)
3. Presence sweeper checks every 5s for missing keys
4. When sweeper detects offline transition, broadcasts update
5. All connected clients receive presence update instantly

### Why Not Just Use WebSocket Close?
- WebSocket close events are unreliable
- App might crash without clean close
- Network issues may not trigger close immediately
- TTL-based detection is the source of truth

## Troubleshooting

### Backend won't start

**Error: "Redis connection failed"**
- Make sure Redis is running: `redis-cli ping`
- Check REDIS_URL in `.env`
- For WSL, ensure Ubuntu is running: `wsl`

**Error: "Port 3000 already in use"**
- Change PORT in `.env` to another port (e.g., 3001)
- Update mobile `config.ts` accordingly

### Mobile app can't connect

**Error: "Network error" when logging in**
1. Verify backend is running: Check `http://YOUR_IP:3000/health` in browser
2. Make sure device and computer are on same WiFi
3. Update `mobile/src/config.ts` with correct IP
4. Check Windows Firewall isn't blocking port 3000

**Connection indicator shows "Disconnected"**
- Check WebSocket URL in config (should be `ws://`, not `http://`)
- Verify backend logs show WebSocket connection attempts
- Try restarting the app

### Users not going offline

- Check presence sweeper is running (backend logs should show checks)
- Verify TTL is working: `redis-cli GET presence:user@test.com`
- Wait full TTL (45s) + sweeper interval (5s) = 50 seconds

### Redis commands (debugging)

```bash
# Connect to Redis CLI
redis-cli

# List all users
SMEMBERS users:all

# Check if user is online
EXISTS presence:alice@test.com

# Get TTL for presence key
TTL presence:alice@test.com

# Delete all presence keys (reset)
KEYS presence:* | xargs redis-cli DEL

# Delete all users (reset)
DEL users:all
```

## Development Notes

- Email normalization: All emails are trimmed and lowercased
- Heartbeat interval (15s) must be less than TTL (45s)
- Sweeper interval (5s) determines offline detection latency
- WebSocket reconnection: Up to 5 attempts with 2s delay
- No authentication/authorization - this is a demo

## Production Considerations

For production use, consider:
- Add proper authentication (JWT, OAuth)
- Use Redis Sentinel/Cluster for high availability
- Enable Redis keyspace notifications as alternative to sweeper
- Add rate limiting for API and WebSocket
- Use HTTPS/WSS for encrypted connections
- Add monitoring and alerting
- Implement proper error recovery
- Add user activity tracking beyond just presence

## License

MIT

## Support

For issues or questions, create an issue in the repository.
