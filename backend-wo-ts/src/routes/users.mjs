import { Router } from 'express';
import { presenceService } from '../services/presence.mjs';

export const usersRouter = Router();

/**
 * GET /users
 *
 * Query params:
 *   - emails: comma-separated list of emails to fetch
 *   - cursor: pagination cursor
 *   - limit: max users to return (default 50, max 100)
 *
 * NOTE:
 * Your PresenceService no longer has getUsersPaginated() in the new scalable design,
 * so this router falls back safely when pagination isn't available.
 */
usersRouter.get('/users', async (req, res) => {
  try {
    const { emails, cursor, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr, 10) || 50, 100);

    // Ensure Redis connected
    await presenceService.connect?.();

    // If specific emails requested, do batch lookup
    if (emails && typeof emails === 'string') {
      const emailList = emails
        .split(',')
        .map((e) => String(e).trim())
        .filter(Boolean);

      if (emailList.length > 500) {
        return res.status(400).json({ ok: false, error: 'Maximum 500 emails per request' });
      }

      // Prefer list-style batch (online + lastActiveAt + bucket)
      if (typeof presenceService.getBatchPresenceForList === 'function') {
        const users = await presenceService.getBatchPresenceForList(emailList);
        return res.json({ users, hasMore: false });
      }

      // Backward-compatible fallback
      if (typeof presenceService.getBatchPresenceWithLastSeen === 'function') {
        const users = await presenceService.getBatchPresenceWithLastSeen(emailList);
        return res.json({ users, hasMore: false });
      }

      return res.status(500).json({ ok: false, error: 'Batch presence method not available' });
    }

    // Pagination path:
    // If getUsersPaginated exists, use it; otherwise fall back to demo list.
    if (typeof presenceService.getUsersPaginated === 'function') {
      const result = await presenceService.getUsersPaginated(cursor, limit);
      return res.json(result);
    }

    // Demo/dev fallback: return first N users (NOT scalable, but works locally)
    if (typeof presenceService.getAllUsers === 'function') {
      const all = await presenceService.getAllUsers();
      const usersPage = Array.isArray(all) ? all.slice(0, limit) : [];

      let users = [];
      if (typeof presenceService.getBatchPresenceForList === 'function') {
        users = await presenceService.getBatchPresenceForList(usersPage);
      } else if (typeof presenceService.getBatchPresenceWithLastSeen === 'function') {
        users = await presenceService.getBatchPresenceWithLastSeen(usersPage);
      } else {
        users = usersPage.map((email) => ({ email, online: false }));
      }

      return res.json({ users, nextCursor: null, hasMore: false });
    }

    return res.status(500).json({ ok: false, error: 'User listing method not available' });
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
 *
 * Body: { emails: string[] }
 * Returns: { users: Array<{ email, online, lastActiveAt?, lastSeen? }> }
 *
 * Prefer getBatchPresenceForList for LinkedIn-style "active" + online.
 */
usersRouter.post('/users/presence', async (req, res) => {
  try {
    const { emails } = req.body;

    await presenceService.connect?.();

    if (!Array.isArray(emails)) {
      return res.status(400).json({ ok: false, error: 'emails must be an array' });
    }

    if (emails.length > 500) {
      return res.status(400).json({ ok: false, error: 'Maximum 500 emails per request' });
    }

    if (typeof presenceService.getBatchPresenceForList === 'function') {
      const users = await presenceService.getBatchPresenceForList(emails);
      return res.json({ users });
    }

    // Backward-compatible fallback
    if (typeof presenceService.getBatchPresenceWithLastSeen === 'function') {
      const users = await presenceService.getBatchPresenceWithLastSeen(emails);
      return res.json({ users });
    }

    return res.status(500).json({ ok: false, error: 'Batch presence method not available' });
  } catch (error) {
    console.error('Batch presence error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});
