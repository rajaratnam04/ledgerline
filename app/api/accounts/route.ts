import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { randomUUID } from 'node:crypto';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();

  if (user.role === 'ADMIN' || user.role === 'AUDITOR') {
    const accounts = db.prepare(`
      SELECT a.*, u.username as owner_username
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at ASC
    `).all();
    return NextResponse.json({ accounts });
  }

  // Account holder: their accounts
  const myAccounts = db.prepare(`
    SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC
  `).all(user.id);

  // Other accounts available for transfer (public directory)
  const transferTargets = db.prepare(`
    SELECT id, name, user_id FROM accounts WHERE user_id != ?
  `).all(user.id);

  return NextResponse.json({ accounts: myAccounts, transferTargets });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name } = await request.json();
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Account name is required' }, { status: 400 });
    }

    const db = getDb();
    const accountId = `acc_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO accounts (id, user_id, name, balance, currency, created_at)
      VALUES (?, ?, ?, 0, 'INR', ?)
    `).run(accountId, user.id, name.trim(), now);

    return NextResponse.json({
      success: true,
      account: {
        id: accountId,
        user_id: user.id,
        name: name.trim(),
        balance: 0,
        currency: 'INR',
        created_at: now,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
