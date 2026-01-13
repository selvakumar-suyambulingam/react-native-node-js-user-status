import { Router } from 'express';
import { presenceService } from '../services/presence.mjs';

export const usersRouter = Router();

/**
 * GET /users
 * Returns: { users: Array<{ email: string, online: boolean }> }
 */
usersRouter.get('/users', async (req, res) => {
  try {
    const users = await presenceService.getUsersWithStatus();

    console.log(`Fetched ${users.length} users`);

    return res.json({
      users,
    });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});
