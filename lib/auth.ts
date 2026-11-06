import { createHmac, randomBytes } from 'node:crypto';
import { getDb, verifyPassword } from './db.ts';
import { cookies } from 'next/headers';

const SECRET_KEY = process.env.SESSION_SECRET || 'ledgerline-secret-key-production-strength-2026';

export interface UserSession {
  id: string;
  username: string;
  role: 'ADMIN' | 'ACCOUNT_HOLDER' | 'AUDITOR';
}

export function createSessionToken(user: UserSession): string {
  const payload = JSON.stringify({
    id: user.id,
    username: user.username,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  const signature = createHmac('sha256', SECRET_KEY).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string): UserSession | null {
  try {
    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) return null;

    const expectedSignature = createHmac('sha256', SECRET_KEY).update(encodedPayload).digest('base64url');
    if (signature !== expectedSignature) return null;

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) return null;

    return {
      id: payload.id,
      username: payload.username,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<UserSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('ledgerline_session')?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export function authenticateUser(username: string, plainPass: string): UserSession | null {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user) return null;

  const valid = verifyPassword(plainPass, user.password_hash);
  if (!valid) return null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}
