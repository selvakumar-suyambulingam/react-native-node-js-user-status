import { config } from '../config';

export interface User {
  email: string;
  online: boolean;
  lastSeen?: number | null;
}

export interface LoginResponse {
  ok: boolean;
  email?: string;
  error?: string;
}

export interface UsersResponse {
  users: User[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

/**
 * Login with email
 */
export async function login(email: string): Promise<LoginResponse> {
  try {
    const response = await fetch(`${config.apiBaseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Login error:', error);
    return {
      ok: false,
      error: 'Network error',
    };
  }
}

/**
 * Get users with pagination - SCALABLE.
 * Use this for discovery/browsing users.
 *
 * @param cursor - Email to start after (for pagination)
 * @param limit - Max users to return (default 50, max 100)
 */
export async function getUsers(
  cursor?: string,
  limit: number = 50
): Promise<UsersResponse> {
  try {
    const params = new URLSearchParams();
    if (cursor) params.append('cursor', cursor);
    params.append('limit', String(limit));

    const url = `${config.apiBaseUrl}/users?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Get users error:', error);
    return {
      users: [],
      hasMore: false,
    };
  }
}

export async function getPresenceBatch(emails: string[]) {
  const res = await fetch(`${config.apiBaseUrl}/users/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails }),
  });

  if (!res.ok) throw new Error('presence batch failed');
  const json = await res.json();
  return json.users;
}

/**
 * Get presence for specific users - SCALABLE.
 * Use this when you have a contacts list and want their presence.
 *
 * @param emails - Array of emails to fetch presence for (max 500)
 */
export async function getUsersPresence(emails: string[]): Promise<UsersResponse> {
  try {
    if (emails.length === 0) {
      return { users: [], hasMore: false };
    }

    // Use POST for large lists to avoid URL length limits
    if (emails.length > 20) {
      const response = await fetch(`${config.apiBaseUrl}/users/presence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ emails }),
      });
      const data = await response.json();
      return { users: data.users || [], hasMore: false };
    }

    // Use GET with query params for small lists
    const params = new URLSearchParams();
    params.append('emails', emails.join(','));

    const url = `${config.apiBaseUrl}/users?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Get users presence error:', error);
    return {
      users: [],
      hasMore: false,
    };
  }
}

/**
 * Load more users (pagination helper)
 */
export async function loadMoreUsers(
  currentUsers: User[],
  limit: number = 50
): Promise<{ users: User[]; hasMore: boolean }> {
  const lastUser = currentUsers[currentUsers.length - 1];
  const cursor = lastUser?.email;

  const response = await getUsers(cursor, limit);
  return {
    users: [...currentUsers, ...response.users],
    hasMore: response.hasMore || false,
  };
}
