# Quick Start Guide

Get the presence tracker running in 5 minutes!

## Prerequisites Check

- [ ] Node.js 20+ installed
- [ ] Redis running locally
- [ ] Expo Go app on your phone (or Android emulator)

## Step 1: Install Redis (if not already installed)

### Windows - WSL Method (Recommended)

```bash
wsl --install
wsl
sudo apt update
sudo apt install redis-server
sudo service redis-server start
redis-cli ping  # Should return PONG
```

## Step 2: Backend Setup

```bash
cd backend
npm install
npm run dev
```

Wait for: `Server running on port 3000`

## Step 3: Get Your IP Address

```bash
# Windows
ipconfig
```

Look for "IPv4 Address", example: `192.168.1.100`

## Step 4: Update Mobile Config

Edit `mobile/src/config.ts`:

```typescript
const HOST = '192.168.1.100'; // <- Put YOUR IP here
```

## Step 5: Run Mobile App

```bash
cd mobile
npm install
npx expo start
```

Scan QR code with Expo Go app on your phone.

## Step 6: Test It

1. Enter email: `alice@test.com`
2. Tap "Login"
3. You should see yourself as ONLINE

## Step 7: Test Two Users

- Install on second device, login as `bob@test.com`
- OR use web: `npx expo start --web` in new terminal
- Both users should see each other as ONLINE

## Step 8: Test Offline Detection

1. Close app on one device
2. Wait ~50 seconds
3. Other device should show user as OFFLINE

## Troubleshooting

**Can't connect?**
- Make sure phone and computer are on same WiFi
- Check Windows Firewall allows port 3000
- Visit `http://YOUR_IP:3000/health` in phone browser to test

**Redis error?**
- Run: `redis-cli ping` (should return PONG)
- Check Redis is running: `sudo service redis-server status`

## Next Steps

See [README.md](README.md) for:
- Detailed architecture
- API reference
- Production considerations
- Advanced debugging
