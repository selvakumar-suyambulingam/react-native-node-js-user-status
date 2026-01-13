import { Router, Request, Response } from 'express';
import { presenceService } from '../services/presence';

export const usersRouter = Router();

/**
 * GET /users
 * Returns: { users: Array<{ email: string, online: boolean }> }
 */
usersRouter.get('/users', async (req: Request, res: Response) => {
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
