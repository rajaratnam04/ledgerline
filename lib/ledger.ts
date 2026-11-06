import { getDb } from './db.ts';
import { createHash, randomUUID } from 'node:crypto';

export interface TransferParams {
  fromAccountId: string;
  toAccountId: string;
  amountPaise: number;
  actorUserId: string;
  idempotencyKey?: string;
  description?: string;
}

export interface DepositParams {
  accountId: string;
  amountPaise: number;
  actorUserId: string;
  idempotencyKey?: string;
  description?: string;
}

export interface WithdrawalParams {
  accountId: string;
  amountPaise: number;
  actorUserId: string;
  idempotencyKey?: string;
  description?: string;
}

export interface LedgerResult {
  success: boolean;
  transactionId?: string;
  fromBalance?: number;
  toBalance?: number;
  message?: string;
  isDuplicate?: boolean;
}

// Compute SHA-256 hash for ledger chaining
export function computeEntryHash(
  prevHash: string,
  entryId: string,
  transactionId: string,
  accountId: string,
  direction: string,
  amount: number,
  runningBalance: number,
  createdAt: string
): string {
  const payload = `${prevHash}:${entryId}:${transactionId}:${accountId}:${direction}:${amount}:${runningBalance}:${createdAt}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Executes a money transfer between two accounts with:
 * 1. Strict double-entry accounting (1 debit + 1 credit)
 * 2. Pessimistic concurrency locking (BEGIN IMMEDIATE)
 * 3. Deterministic lock order to prevent deadlocks
 * 4. Idempotency replay protection
 * 5. Server-side authorization check
 * 6. Refusal logging on failure
 * 7. Cryptographic SHA-256 chaining
 */
export function executeTransfer(params: TransferParams): LedgerResult {
  const db = getDb();
  const { fromAccountId, toAccountId, amountPaise, actorUserId, idempotencyKey, description } = params;

  if (amountPaise <= 0 || !Number.isInteger(amountPaise)) {
    throw new Error('Amount must be a positive integer in paise (cents).');
  }

  if (fromAccountId === toAccountId) {
    throw new Error('Cannot transfer money to the same account.');
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ fromAccountId, toAccountId, amountPaise, actorUserId }))
    .digest('hex');

  // Check Idempotency Key
  if (idempotencyKey) {
    const existingKey = db.prepare('SELECT * FROM idempotency_records WHERE key = ?').get(idempotencyKey) as any;
    if (existingKey) {
      if (existingKey.status === 'SUCCEEDED') {
        const cached = JSON.parse(existingKey.response_body);
        return { ...cached, isDuplicate: true };
      }
      if (existingKey.status === 'PENDING') {
        throw new Error('Concurrent request with this idempotency key is already in progress.');
      }
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO idempotency_records (key, request_hash, status, created_at, updated_at)
        VALUES (?, ?, 'PENDING', ?, ?)
      `).run(idempotencyKey, payloadHash, now, now);
    }
  }

  const now = new Date().toISOString();
  const txnId = `txn_${randomUUID()}`;
  let refusalRecord: { accountId: string; actorUserId: string; actionType: string; amount: number; reason: string } | null = null;

  // Acquire immediate exclusive lock for the transaction
  db.exec('BEGIN IMMEDIATE;');

  try {
    // 1. Fetch and Lock Accounts in deterministic sorted order to prevent deadlocks
    const [firstId, secondId] = [fromAccountId, toAccountId].sort();
    
    const firstAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(firstId) as any;
    const secondAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(secondId) as any;

    const fromAcc = fromAccountId === firstId ? firstAcc : secondAcc;
    const toAcc = toAccountId === firstId ? firstAcc : secondAcc;

    if (!fromAcc) {
      refusalRecord = { accountId: fromAccountId, actorUserId, actionType: 'TRANSFER', amount: amountPaise, reason: 'Source account does not exist' };
      throw new Error(`Source account ${fromAccountId} does not exist.`);
    }

    if (!toAcc) {
      refusalRecord = { accountId: fromAccountId, actorUserId, actionType: 'TRANSFER', amount: amountPaise, reason: 'Destination account does not exist' };
      throw new Error(`Destination account ${toAccountId} does not exist.`);
    }

    // 2. Server-side Authorization Check
    const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(actorUserId) as any;
    if (!actor) {
      refusalRecord = { accountId: fromAccountId, actorUserId, actionType: 'TRANSFER', amount: amountPaise, reason: 'Actor user not found' };
      throw new Error('Unauthorized actor.');
    }

    if (actor.role !== 'ADMIN' && fromAcc.user_id !== actorUserId) {
      refusalRecord = { accountId: fromAccountId, actorUserId, actionType: 'TRANSFER', amount: amountPaise, reason: 'Unauthorized: user does not own source account' };
      throw new Error('Forbidden: You are not authorized to transfer funds from this account.');
    }

    // 3. Balance Invariant Check
    if (fromAcc.balance < amountPaise) {
      refusalRecord = { accountId: fromAccountId, actorUserId, actionType: 'TRANSFER', amount: amountPaise, reason: `Insufficient balance: available ${fromAcc.balance}, requested ${amountPaise}` };
      throw new Error(`Insufficient funds: account has ₹${(fromAcc.balance / 100).toFixed(2)}, cannot transfer ₹${(amountPaise / 100).toFixed(2)}.`);
    }

    // 4. Update Balances Atomically
    const newFromBalance = fromAcc.balance - amountPaise;
    const newToBalance = toAcc.balance + amountPaise;

    db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(newFromBalance, fromAccountId);
    db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(newToBalance, toAccountId);

    // 5. Insert High-level Transaction
    db.prepare(`
      INSERT INTO transactions (id, type, amount, from_account_id, to_account_id, actor_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'TRANSFER', ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)
    `).run(txnId, amountPaise, fromAccountId, toAccountId, actorUserId, idempotencyKey || null, description || 'Account Transfer', now);

    // 6. Cryptographic Double-Entry Ledger Postings
    // Get latest ledger entry hash for chain continuity
    const latestEntry = db.prepare('SELECT hash FROM ledger_entries ORDER BY id DESC LIMIT 1').get() as any;
    let prevHash = latestEntry ? latestEntry.hash : '0000000000000000000000000000000000000000000000000000000000000000';

    // Entry 1: DEBIT from source
    const debitEntryId = `led_${randomUUID()}`;
    const debitHash = computeEntryHash(prevHash, debitEntryId, txnId, fromAccountId, 'DEBIT', amountPaise, newFromBalance, now);
    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?)
    `).run(debitEntryId, txnId, fromAccountId, amountPaise, newFromBalance, prevHash, debitHash, now);

    // Entry 2: CREDIT to destination
    const creditEntryId = `led_${randomUUID()}`;
    const creditHash = computeEntryHash(debitHash, creditEntryId, txnId, toAccountId, 'CREDIT', amountPaise, newToBalance, now);
    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?)
    `).run(creditEntryId, txnId, toAccountId, amountPaise, newToBalance, debitHash, creditHash, now);

    const result: LedgerResult = {
      success: true,
      transactionId: txnId,
      fromBalance: newFromBalance,
      toBalance: newToBalance,
      message: `Successfully transferred ₹${(amountPaise / 100).toFixed(2)}.`,
    };

    // 7. Update Idempotency Record
    if (idempotencyKey) {
      db.prepare(`
        UPDATE idempotency_records
        SET status = 'SUCCEEDED', response_code = 200, response_body = ?, updated_at = ?
        WHERE key = ?
      `).run(JSON.stringify(result), now, idempotencyKey);
    }

    db.exec('COMMIT;');
    return result;
  } catch (err: any) {
    try {
      db.exec('ROLLBACK;');
    } catch {}

    if (refusalRecord) {
      logRefusal(db, refusalRecord.accountId, refusalRecord.actorUserId, refusalRecord.actionType, refusalRecord.amount, refusalRecord.reason);
    }

    if (idempotencyKey) {
      try {
        db.prepare(`
          UPDATE idempotency_records
          SET status = 'FAILED', response_code = 400, response_body = ?, updated_at = ?
          WHERE key = ?
        `).run(JSON.stringify({ error: err.message }), new Date().toISOString(), idempotencyKey);
      } catch {}
    }
    throw err;
  }
}

/**
 * Executes an external deposit into an account.
 */
export function executeDeposit(params: DepositParams): LedgerResult {
  const db = getDb();
  const { accountId, amountPaise, actorUserId, idempotencyKey, description } = params;

  if (amountPaise <= 0 || !Number.isInteger(amountPaise)) {
    throw new Error('Deposit amount must be a positive integer in paise.');
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ accountId, amountPaise, actorUserId }))
    .digest('hex');

  if (idempotencyKey) {
    const existingKey = db.prepare('SELECT * FROM idempotency_records WHERE key = ?').get(idempotencyKey) as any;
    if (existingKey) {
      if (existingKey.status === 'SUCCEEDED') {
        const cached = JSON.parse(existingKey.response_body);
        return { ...cached, isDuplicate: true };
      }
      if (existingKey.status === 'PENDING') {
        throw new Error('Concurrent deposit request in progress.');
      }
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO idempotency_records (key, request_hash, status, created_at, updated_at)
        VALUES (?, ?, 'PENDING', ?, ?)
      `).run(idempotencyKey, payloadHash, now, now);
    }
  }

  const now = new Date().toISOString();
  const txnId = `txn_${randomUUID()}`;
  let refusalRecord: { accountId: string; actorUserId: string; actionType: string; amount: number; reason: string } | null = null;

  db.exec('BEGIN IMMEDIATE;');

  try {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
    if (!acc) {
      refusalRecord = { accountId, actorUserId, actionType: 'DEPOSIT', amount: amountPaise, reason: 'Target account not found' };
      throw new Error(`Account ${accountId} does not exist.`);
    }

    const newBalance = acc.balance + amountPaise;
    db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(newBalance, accountId);

    db.prepare(`
      INSERT INTO transactions (id, type, amount, from_account_id, to_account_id, actor_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'DEPOSIT', ?, NULL, ?, ?, ?, ?, 'COMPLETED', ?)
    `).run(txnId, amountPaise, accountId, actorUserId, idempotencyKey || null, description || 'External Deposit', now);

    const latestEntry = db.prepare('SELECT hash FROM ledger_entries ORDER BY id DESC LIMIT 1').get() as any;
    const prevHash = latestEntry ? latestEntry.hash : '0000000000000000000000000000000000000000000000000000000000000000';

    const entryId = `led_${randomUUID()}`;
    const hash = computeEntryHash(prevHash, entryId, txnId, accountId, 'CREDIT', amountPaise, newBalance, now);
    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?)
    `).run(entryId, txnId, accountId, amountPaise, newBalance, prevHash, hash, now);

    const result: LedgerResult = {
      success: true,
      transactionId: txnId,
      toBalance: newBalance,
      message: `Successfully deposited ₹${(amountPaise / 100).toFixed(2)}.`,
    };

    if (idempotencyKey) {
      db.prepare(`
        UPDATE idempotency_records
        SET status = 'SUCCEEDED', response_code = 200, response_body = ?, updated_at = ?
        WHERE key = ?
      `).run(JSON.stringify(result), now, idempotencyKey);
    }

    db.exec('COMMIT;');
    return result;
  } catch (err: any) {
    try {
      db.exec('ROLLBACK;');
    } catch {}

    if (refusalRecord) {
      logRefusal(db, refusalRecord.accountId, refusalRecord.actorUserId, refusalRecord.actionType, refusalRecord.amount, refusalRecord.reason);
    }
    throw err;
  }
}

/**
 * Executes an external withdrawal from an account.
 */
export function executeWithdrawal(params: WithdrawalParams): LedgerResult {
  const db = getDb();
  const { accountId, amountPaise, actorUserId, idempotencyKey, description } = params;

  if (amountPaise <= 0 || !Number.isInteger(amountPaise)) {
    throw new Error('Withdrawal amount must be a positive integer in paise.');
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ accountId, amountPaise, actorUserId }))
    .digest('hex');

  if (idempotencyKey) {
    const existingKey = db.prepare('SELECT * FROM idempotency_records WHERE key = ?').get(idempotencyKey) as any;
    if (existingKey) {
      if (existingKey.status === 'SUCCEEDED') {
        const cached = JSON.parse(existingKey.response_body);
        return { ...cached, isDuplicate: true };
      }
      if (existingKey.status === 'PENDING') {
        throw new Error('Concurrent withdrawal request in progress.');
      }
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO idempotency_records (key, request_hash, status, created_at, updated_at)
        VALUES (?, ?, 'PENDING', ?, ?)
      `).run(idempotencyKey, payloadHash, now, now);
    }
  }

  const now = new Date().toISOString();
  const txnId = `txn_${randomUUID()}`;
  let refusalRecord: { accountId: string; actorUserId: string; actionType: string; amount: number; reason: string } | null = null;

  db.exec('BEGIN IMMEDIATE;');

  try {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
    if (!acc) {
      refusalRecord = { accountId, actorUserId, actionType: 'WITHDRAWAL', amount: amountPaise, reason: 'Target account not found' };
      throw new Error(`Account ${accountId} does not exist.`);
    }

    // Authorization
    const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(actorUserId) as any;
    if (actor.role !== 'ADMIN' && acc.user_id !== actorUserId) {
      refusalRecord = { accountId, actorUserId, actionType: 'WITHDRAWAL', amount: amountPaise, reason: 'Unauthorized account access' };
      throw new Error('Forbidden: You are not authorized to withdraw funds from this account.');
    }

    // Invariant check
    if (acc.balance < amountPaise) {
      refusalRecord = { accountId, actorUserId, actionType: 'WITHDRAWAL', amount: amountPaise, reason: `Insufficient balance: ${acc.balance} < ${amountPaise}` };
      throw new Error(`Insufficient funds: account has ₹${(acc.balance / 100).toFixed(2)}, cannot withdraw ₹${(amountPaise / 100).toFixed(2)}.`);
    }

    const newBalance = acc.balance - amountPaise;
    db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(newBalance, accountId);

    db.prepare(`
      INSERT INTO transactions (id, type, amount, from_account_id, to_account_id, actor_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'WITHDRAWAL', ?, ?, NULL, ?, ?, ?, 'COMPLETED', ?)
    `).run(txnId, amountPaise, accountId, actorUserId, idempotencyKey || null, description || 'External Withdrawal', now);

    const latestEntry = db.prepare('SELECT hash FROM ledger_entries ORDER BY id DESC LIMIT 1').get() as any;
    const prevHash = latestEntry ? latestEntry.hash : '0000000000000000000000000000000000000000000000000000000000000000';

    const entryId = `led_${randomUUID()}`;
    const hash = computeEntryHash(prevHash, entryId, txnId, accountId, 'DEBIT', amountPaise, newBalance, now);
    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?)
    `).run(entryId, txnId, accountId, amountPaise, newBalance, prevHash, hash, now);

    const result: LedgerResult = {
      success: true,
      transactionId: txnId,
      fromBalance: newBalance,
      message: `Successfully withdrew ₹${(amountPaise / 100).toFixed(2)}.`,
    };

    if (idempotencyKey) {
      db.prepare(`
        UPDATE idempotency_records
        SET status = 'SUCCEEDED', response_code = 200, response_body = ?, updated_at = ?
        WHERE key = ?
      `).run(JSON.stringify(result), now, idempotencyKey);
    }

    db.exec('COMMIT;');
    return result;
  } catch (err: any) {
    try {
      db.exec('ROLLBACK;');
    } catch {}

    if (refusalRecord) {
      logRefusal(db, refusalRecord.accountId, refusalRecord.actorUserId, refusalRecord.actionType, refusalRecord.amount, refusalRecord.reason);
    }
    throw err;
  }
}

/**
 * Returns statement for an account including credits, debits, running balances,
 * actor information, and refused attempts!
 */
export function getAccountStatement(accountId: string, requestingUserId: string) {
  const db = getDb();
  
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!acc) throw new Error('Account not found.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(requestingUserId) as any;
  if (user.role !== 'ADMIN' && user.role !== 'AUDITOR' && acc.user_id !== requestingUserId) {
    throw new Error('Forbidden: You can only view statements for accounts you own.');
  }

  // Fetch postings with transaction metadata
  const entries = db.prepare(`
    SELECT 
      le.id,
      le.entry_id,
      le.transaction_id,
      le.account_id,
      le.direction,
      le.amount,
      le.running_balance,
      le.hash,
      le.prev_hash,
      le.created_at,
      t.type as txn_type,
      t.description,
      u.username as actor_name
    FROM ledger_entries le
    JOIN transactions t ON le.transaction_id = t.id
    JOIN users u ON t.actor_user_id = u.id
    WHERE le.account_id = ?
    ORDER BY le.id ASC
  `).all(accountId) as any[];

  // Fetch refused attempts
  const refused = db.prepare(`
    SELECT r.*, u.username as actor_name
    FROM refused_attempts r
    LEFT JOIN users u ON r.actor_user_id = u.id
    WHERE r.account_id = ?
    ORDER BY r.id DESC
  `).all(accountId) as any[];

  return {
    account: {
      id: acc.id,
      name: acc.name,
      balance: acc.balance,
      currency: acc.currency,
      userId: acc.user_id,
    },
    entries,
    refusedAttempts: refused,
  };
}

/**
 * Cryptographic Ledger Proof & Conservation Invariant Check
 * 1. Checks that sum(balances) == sum(deposits) - sum(withdrawals)
 * 2. Re-hashes every ledger entry from genesis to tip to prove zero tampering
 */
export function verifyLedgerProof() {
  const db = getDb();

  // 1. Conservation of Money Invariant Check
  const balanceRow = db.prepare('SELECT SUM(balance) as total_balance FROM accounts').get() as any;
  const totalBalance = balanceRow?.total_balance || 0;

  const depositRow = db.prepare("SELECT SUM(amount) as total_deposit FROM transactions WHERE type = 'DEPOSIT' AND status = 'COMPLETED'").get() as any;
  const totalDeposits = depositRow?.total_deposit || 0;

  const withdrawalRow = db.prepare("SELECT SUM(amount) as total_withdrawal FROM transactions WHERE type = 'WITHDRAWAL' AND status = 'COMPLETED'").get() as any;
  const totalWithdrawals = withdrawalRow?.total_withdrawal || 0;

  const expectedBalance = totalDeposits - totalWithdrawals;
  const conservationHolds = totalBalance === expectedBalance;

  // 2. Cryptographic SHA-256 Chain Verification
  const entries = db.prepare('SELECT * FROM ledger_entries ORDER BY id ASC').all() as any[];
  let chainValid = true;
  let brokenEntryId: string | null = null;
  let reason: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    
    // Check prev_hash matches previous entry's hash
    if (i > 0) {
      const prevEntry = entries[i - 1];
      if (entry.prev_hash !== prevEntry.hash) {
        chainValid = false;
        brokenEntryId = entry.entry_id;
        reason = `Broken link at entry ${entry.entry_id}: prev_hash does not match previous entry hash.`;
        break;
      }
    }

    // Recompute hash
    const expectedHash = computeEntryHash(
      entry.prev_hash,
      entry.entry_id,
      entry.transaction_id,
      entry.account_id,
      entry.direction,
      entry.amount,
      entry.running_balance,
      entry.created_at
    );

    if (entry.hash !== expectedHash) {
      chainValid = false;
      brokenEntryId = entry.entry_id;
      reason = `Tampered hash at entry ${entry.entry_id}: computed ${expectedHash} != stored ${entry.hash}`;
      break;
    }
  }

  return {
    verified: chainValid && conservationHolds,
    chainValid,
    brokenEntryId,
    tamperReason: reason,
    totalEntriesChecked: entries.length,
    conservation: {
      holds: conservationHolds,
      totalCurrentBalance: totalBalance,
      totalExternalDeposits: totalDeposits,
      totalExternalWithdrawals: totalWithdrawals,
      expectedBalance,
      discrepancy: totalBalance - expectedBalance,
    },
    verifiedAt: new Date().toISOString(),
  };
}

function logRefusal(db: any, accountId: string | null, actorUserId: string | null, actionType: string, amount: number, reason: string) {
  try {
    db.prepare(`
      INSERT INTO refused_attempts (account_id, actor_user_id, action_type, amount, reason, ip_or_client, created_at)
      VALUES (?, ?, ?, ?, ?, 'system', ?)
    `).run(accountId || 'UNKNOWN', actorUserId || 'ANONYMOUS', actionType, amount, reason, new Date().toISOString());
  } catch (err) {
    console.error('Failed to log refusal:', err);
  }
}
