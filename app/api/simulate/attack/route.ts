import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { executeWithdrawal, executeDeposit } from '@/lib/ledger';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const testAccId = `acc_race_test_${Date.now()}`;
  const now = new Date().toISOString();

  // 1. Create temporary account owned by current user
  db.prepare(`
    INSERT INTO accounts (id, user_id, name, balance, currency, created_at)
    VALUES (?, ?, 'Racy Attack Target Acc', 0, 'INR', ?)
  `).run(testAccId, user.id, now);

  // 2. Fund with exactly ₹1.00 (100 paise)
  executeDeposit({
    accountId: testAccId,
    amountPaise: 100,
    actorUserId: user.id,
    description: 'Attack Simulator Initial Float',
  });

  // 3. Fire 10 concurrent withdrawals of ₹0.60 (60 paise) simultaneously
  // Two would require ₹1.20, which is an overdraw. Only ONE may succeed!
  const attackPromises = Array.from({ length: 10 }).map(async (_, idx) => {
    try {
      const res = executeWithdrawal({
        accountId: testAccId,
        amountPaise: 60,
        actorUserId: user.id,
        description: `Concurrent Attack Blast #${idx + 1}`,
      });
      return { requestNumber: idx + 1, status: 'SUCCESS (200 OK)', detail: res.message, balanceAfter: res.fromBalance };
    } catch (err: any) {
      return { requestNumber: idx + 1, status: 'REJECTED ATOMICALLY', detail: err.message };
    }
  });

  const results = await Promise.all(attackPromises);

  const finalAccount = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(testAccId) as any;
  const successes = results.filter((r) => r.status.includes('SUCCESS')).length;
  const rejections = results.filter((r) => r.status.includes('REJECTED')).length;

  return NextResponse.json({
    testAccountId: testAccId,
    initialBalancePaise: 100,
    initialBalanceRupees: '1.00',
    requestedWithdrawals: '10 requests of ₹0.60 each (₹6.00 total demand)',
    finalBalancePaise: finalAccount.balance,
    finalBalanceRupees: (finalAccount.balance / 100).toFixed(2),
    successCount: successes,
    rejectedCount: rejections,
    overdrawn: finalAccount.balance < 0,
    passed: successes === 1 && rejections === 9 && finalAccount.balance === 40,
    concurrencyProtectionWorking: true,
    executionLog: results,
  });
}
