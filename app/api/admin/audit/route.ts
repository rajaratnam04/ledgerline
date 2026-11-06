import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function GET() {
  const user = await getCurrentUser();
  if (!user || (user.role !== 'ADMIN' && user.role !== 'AUDITOR')) {
    return NextResponse.json({ error: 'Forbidden: Admin or Auditor role required' }, { status: 403 });
  }

  const db = getDb();

  const refusals = db.prepare(`
    SELECT r.*, u.username as actor_name
    FROM refused_attempts r
    LEFT JOIN users u ON r.actor_user_id = u.id
    ORDER BY r.id DESC
    LIMIT 100
  `).all();

  const totalTransactions = db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any;
  const totalLedgerEntries = db.prepare('SELECT COUNT(*) as count FROM ledger_entries').get() as any;

  return NextResponse.json({
    refusals,
    stats: {
      totalTransactions: totalTransactions?.count || 0,
      totalLedgerEntries: totalLedgerEntries?.count || 0,
      totalRefusals: refusals.length,
    },
  });
}
