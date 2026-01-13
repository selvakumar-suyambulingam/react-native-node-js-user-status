import { config } from '../config';

export interface User {
  email: string;
  online: boolean;
}

export interface LoginResponse {
  ok: boolean;
  email?: string;
  error?: string;
}

export interface UsersResponse {
  users: User[];
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
 * Get all users with their online status
 */
export async function getUsers(): Promise<UsersResponse> {
  try {
    const response = await fetch(`${config.apiBaseUrl}/users`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Get users error:', error);
    return {
      users: [],
    };
  }
}
