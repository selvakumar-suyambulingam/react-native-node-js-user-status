import { Router } from 'express';
import { presenceService } from '../services/presence.mjs';

export const authRouter = Router();

/**
 * POST /login
 * Body: { email: string }
 * Returns: { ok: true, email: string }
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Email is required',
      });
    }

    const normalized = presenceService.normalizeEmail(email);

    if (!presenceService.isValidEmail(normalized)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid email format (must contain @)',
      });
    }

    // Register user (adds to users:all set)
    await presenceService.registerUser(normalized);

    console.log(`User logged in: ${normalized}`);

    return res.json({
      ok: true,
      email: normalized,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});
