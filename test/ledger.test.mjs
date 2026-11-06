import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../lib/db.ts';
import {
  executeTransfer,
  executeDeposit,
  executeWithdrawal,
  verifyLedgerProof,
  getAccountStatement
} from '../lib/ledger.ts';
import fs from 'node:fs';
import path from 'node:path';

describe('LedgerLine Money Integrity & Concurrency Test Suite', () => {
  before(() => {
    // Ensure DB is initialized
    getDb();
  });

  test('Invariant 1: Conservation of Money - Transfers strictly net to zero', () => {
    const proofBefore = verifyLedgerProof();
    assert.strictEqual(proofBefore.conservation.holds, true, 'System invariant must hold at start');
    const initialFloat = proofBefore.conservation.totalCurrentBalance;

    // Execute multiple transfers between Alice and Bob
    for (let i = 0; i < 10; i++) {
      executeTransfer({
        fromAccountId: 'acc_alice',
        toAccountId: 'acc_bob',
        amountPaise: 100, // ₹1.00
        actorUserId: 'usr_alice',
        description: `Stress Transfer ${i}`,
      });

      executeTransfer({
        fromAccountId: 'acc_bob',
        toAccountId: 'acc_alice',
        amountPaise: 50, // ₹0.50
        actorUserId: 'usr_bob',
        description: `Stress Return ${i}`,
      });
    }

    const proofAfter = verifyLedgerProof();
    assert.strictEqual(proofAfter.conservation.holds, true, 'System invariant must hold after transfers');
    assert.strictEqual(proofAfter.conservation.totalCurrentBalance, initialFloat, 'Total system float cannot change from transfers');
    assert.strictEqual(proofAfter.chainValid, true, 'SHA-256 chain must remain fully valid');
  });

  test('Invariant 2: Concurrency & Overdraw Attack - 15 simultaneous withdrawals past available balance', async () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create a victim account with initial 0 balance, funded via executeDeposit to preserve invariant
    const victimAccountId = `acc_victim_${Date.now()}`;
    const victimUserId = `usr_victim_${Date.now()}`;
    db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'hash', 'ACCOUNT_HOLDER', ?)")
      .run(victimUserId, `victim_${Date.now()}`, now);
    db.prepare("INSERT INTO accounts (id, user_id, name, balance, currency, created_at) VALUES (?, ?, 'Victim Acc', 0, 'INR', ?)")
      .run(victimAccountId, victimUserId, now);

    // Record initial deposit of 100 paise (₹1.00)
    executeDeposit({
      accountId: victimAccountId,
      amountPaise: 100,
      actorUserId: 'usr_admin',
      description: 'Funding Victim Account',
    });

    // Fire 15 concurrent withdrawals of 70 paise each.
    // If concurrency protection is broken, multiple withdrawals will succeed, driving balance negative (-950 paise)!
    // Under proper concurrency locking, EXACTLY 1 must succeed, and 14 must fail.
    const promises = Array.from({ length: 15 }).map(async (_, idx) => {
      try {
        return executeWithdrawal({
          accountId: victimAccountId,
          amountPaise: 70,
          actorUserId: victimUserId,
          description: `Racy withdrawal attempt ${idx}`,
        });
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    assert.strictEqual(successes.length, 1, `Exactly ONE withdrawal of 70 paise must succeed, but got ${successes.length}`);
    assert.strictEqual(failures.length, 14, `Remaining 14 concurrent withdrawals must fail`);

    const finalAccount = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(victimAccountId);
    assert.strictEqual(finalAccount.balance, 30, `Balance must be exactly 30 paise (100 - 70), never negative`);
    assert.ok(finalAccount.balance >= 0, 'Account balance must never drop below 0');
  });

  test('Invariant 3: Exactly-Once Idempotency - Retried requests return cached response without moving money', () => {
    const db = getDb();
    const idempotencyKey = `idemp_test_${Date.now()}`;

    const aliceBefore = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('acc_alice');
    const bobBefore = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('acc_bob');

    // First Call: moves ₹2.00 (200 paise)
    const call1 = executeTransfer({
      fromAccountId: 'acc_alice',
      toAccountId: 'acc_bob',
      amountPaise: 200,
      actorUserId: 'usr_alice',
      idempotencyKey,
      description: 'Idempotency Payment',
    });

    assert.strictEqual(call1.success, true);
    assert.strictEqual(call1.isDuplicate, undefined);

    // Call 2 & 3: Replaying the exact same request with the same Idempotency Key
    const call2 = executeTransfer({
      fromAccountId: 'acc_alice',
      toAccountId: 'acc_bob',
      amountPaise: 200,
      actorUserId: 'usr_alice',
      idempotencyKey,
      description: 'Idempotency Payment',
    });

    const call3 = executeTransfer({
      fromAccountId: 'acc_alice',
      toAccountId: 'acc_bob',
      amountPaise: 200,
      actorUserId: 'usr_alice',
      idempotencyKey,
      description: 'Idempotency Payment',
    });

    assert.strictEqual(call2.isDuplicate, true, 'Second call must be marked as duplicate');
    assert.strictEqual(call3.isDuplicate, true, 'Third call must be marked as duplicate');
    assert.strictEqual(call2.transactionId, call1.transactionId, 'Replay must return same transaction ID');

    // Verify balances moved ONLY ONCE (200 paise, not 600 paise)
    const aliceAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('acc_alice');
    const bobAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('acc_bob');

    assert.strictEqual(aliceAfter.balance, aliceBefore.balance - 200, 'Alice debited exactly once');
    assert.strictEqual(bobAfter.balance, bobBefore.balance + 200, 'Bob credited exactly once');
  });

  test('Invariant 4: Server-Side Authorization - User cannot move another user funds', () => {
    // Bob attempts to initiate a transfer moving money OUT OF Alice's account
    assert.throws(
      () => {
        executeTransfer({
          fromAccountId: 'acc_alice',
          toAccountId: 'acc_bob',
          amountPaise: 500,
          actorUserId: 'usr_bob', // Attacker Bob pretends to transfer from Alice
          description: 'Malicious transfer attempt',
        });
      },
      /Forbidden: You are not authorized/,
      'Server must reject transfer where actor does not own source account'
    );

    // Verify refusal was recorded in the audit trail
    const statement = getAccountStatement('acc_alice', 'usr_alice');
    const unauthorizedRefusals = statement.refusedAttempts.filter(
      (r) => r.actor_user_id === 'usr_bob' && r.action_type === 'TRANSFER'
    );
    assert.ok(unauthorizedRefusals.length > 0, 'Refusal must be logged in audit trail with actor ID');
  });

  test('Invariant 5: Tamper Detection - Cryptographic proof detects altered ledger row', () => {
    const db = getDb();
    const proofBefore = verifyLedgerProof();
    assert.strictEqual(proofBefore.chainValid, true, 'Chain must be valid prior to attack');

    // Attacker manually tampers with a ledger entry in the database
    const latestEntry = db.prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT 1').get();
    const originalAmount = latestEntry.amount;

    try {
      // Malicious SQL update simulating rogue DBA or compromised process
      db.prepare('UPDATE ledger_entries SET amount = ? WHERE id = ?').run(originalAmount + 99999, latestEntry.id);

      const tamperedProof = verifyLedgerProof();
      assert.strictEqual(tamperedProof.chainValid, false, 'Tampered ledger row must break cryptographic chain');
      assert.ok(tamperedProof.tamperReason.includes('Tampered hash'), 'Tamper reason must clearly pinpoint the altered hash');
    } finally {
      // Restore ledger entry so subsequent tests remain intact
      db.prepare('UPDATE ledger_entries SET amount = ? WHERE id = ?').run(originalAmount, latestEntry.id);
    }

    const restoredProof = verifyLedgerProof();
    assert.strictEqual(restoredProof.chainValid, true, 'Restoring original values returns chain to verified status');
  });
});
