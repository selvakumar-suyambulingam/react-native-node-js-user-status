import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config.mjs';
import { presenceService } from './services/presence.mjs';
import { authRouter } from './routes/auth.mjs';
import { usersRouter } from './routes/users.mjs';
import { PresenceWebSocketServer } from './ws/server.mjs';

async function bootstrap() {
  try {
    // Connect to Redis
    console.log('Connecting to Redis...');
    await presenceService.connect();
    console.log('Redis connected successfully');

    // Create Express app
    const app = express();

    // Middleware
    app.use(cors());
    app.use(express.json());

    // Routes
    app.use(authRouter);
    app.use(usersRouter);

    // Health check
    app.get('/health', (req, res) => {
      res.json({ ok: true, timestamp: new Date().toISOString() });
    });

    // Create HTTP server
    const server = createServer(app);

    // Initialize WebSocket server with Redis Pub/Sub
    const wsServer = new PresenceWebSocketServer(server);

    // Start heartbeat check for dead connections
    wsServer.startHeartbeatCheck();

    // Start server
    server.listen(config.port, () => {
      console.log('='.repeat(50));
      console.log(`Server running on port ${config.port}`);
      console.log(`REST API: http://localhost:${config.port}`);
      console.log(`WebSocket: ws://localhost:${config.port}/ws`);
      console.log(`Heartbeat interval: ${config.heartbeatIntervalMs}ms`);
      console.log(`Presence TTL: ${config.presenceTtlSeconds}s`);
      console.log(`Using Redis Pub/Sub for presence updates`);
      console.log(`Using Redis keyspace notifications for TTL expiry`);
      console.log('='.repeat(50));
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down gracefully...');
      await presenceService.disconnect();
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
