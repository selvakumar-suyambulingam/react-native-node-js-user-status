import { Router } from 'express';
import { presenceService } from '../services/presence.mjs';

export const usersRouter = Router();

/**
 * GET /users
 *
 * Query params:
 *   - emails: comma-separated list of emails to fetch (for contacts-based lookup)
 *   - cursor: pagination cursor (email to start after)
 *   - limit: max users to return (default 50, max 100)
 *
 * For scalability:
 *   - If emails provided: returns only those users (batch lookup)
 *   - If no emails: returns paginated list (for admin/discovery)
 */
usersRouter.get('/users', async (req, res) => {
  try {
    const { emails, cursor, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr) || 50, 100);

    // If specific emails requested, do batch lookup (scalable)
    if (emails && typeof emails === 'string') {
      const emailList = emails.split(',').map(e => e.trim()).filter(Boolean);

      if (emailList.length > 500) {
        return res.status(400).json({
          ok: false,
          error: 'Maximum 500 emails per request'
        });
      }

      const users = await presenceService.getBatchPresenceWithLastSeen(emailList);
      console.log(`Batch fetched ${users.length} users`);

      return res.json({ users, hasMore: false });
    }

    // Otherwise, paginated list (for discovery/admin - use sparingly at scale)
    const result = await presenceService.getUsersPaginated(cursor, limit);
    console.log(`Paginated fetch: ${result.users.length} users, hasMore: ${result.hasMore}`);

    return res.json(result);
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});

/**
 * POST /users/presence
 * Batch lookup presence for multiple users (preferred for large contact lists)
 *
 * Body: { emails: string[] }
 * Returns: { users: Array<{ email, online, lastSeen }> }
 */
usersRouter.post('/users/presence', async (req, res) => {
  try {
    const { emails } = req.body;

    if (!Array.isArray(emails)) {
      return res.status(400).json({
        ok: false,
        error: 'emails must be an array'
      });
    }

    if (emails.length > 500) {
      return res.status(400).json({
        ok: false,
        error: 'Maximum 500 emails per request'
      });
    }

    const users = await presenceService.getBatchPresenceWithLastSeen(emails);
    return res.json({ users });
  } catch (error) {
    console.error('Batch presence error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});
