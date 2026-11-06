import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DATABASE_FILE || path.join(process.cwd(), 'ledgerline.db');

let _dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_dbInstance) {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    _dbInstance = new DatabaseSync(DB_PATH);
    
    // Configure SQLite for high concurrency and safety:
    // WAL mode permits concurrent readers while writing
    _dbInstance.exec('PRAGMA journal_mode = WAL;');
    _dbInstance.exec('PRAGMA busy_timeout = 5000;');
    _dbInstance.exec('PRAGMA foreign_keys = ON;');

    initSchema(_dbInstance);
    seedData(_dbInstance);
  }
  return _dbInstance;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(password: string, combinedHash: string): boolean {
  try {
    const [salt, key] = combinedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedBuffer = scryptSync(password, salt, 64);
    return timingSafeEqual(keyBuffer, derivedBuffer);
  } catch {
    return false;
  }
}

function initSchema(db: DatabaseSync) {
  db.exec(`
    -- Users & Roles
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR')),
      created_at TEXT NOT NULL
    );

    -- Accounts with hard database-level constraint: balance can never go below 0
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      created_at TEXT NOT NULL
    );

    -- High-level Transaction Record
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('TRANSFER', 'DEPOSIT', 'WITHDRAWAL')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      from_account_id TEXT REFERENCES accounts(id),
      to_account_id TEXT REFERENCES accounts(id),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_at TEXT NOT NULL
    );

    -- Append-Only Double-Entry Ledger with Cryptographic Hash Chaining
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT UNIQUE NOT NULL,
      transaction_id TEXT NOT NULL REFERENCES transactions(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      direction TEXT NOT NULL CHECK(direction IN ('DEBIT', 'CREDIT')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      running_balance INTEGER NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Refused Attempts Audit Trail (Mandatory per problem spec)
    CREATE TABLE IF NOT EXISTS refused_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      actor_user_id TEXT,
      action_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ip_or_client TEXT,
      created_at TEXT NOT NULL
    );

    -- Idempotency Records with State Tracking to Prevent Replays and In-Flight Races
    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
      response_code INTEGER,
      response_body TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_hash ON ledger_entries(hash);
    CREATE INDEX IF NOT EXISTS idx_refused_account ON refused_attempts(account_id);
  `);
}

function seedData(db: DatabaseSync) {
  const userCountQuery = db.prepare('SELECT COUNT(*) as count FROM users');
  const userCount = (userCountQuery.get() as any)?.count || 0;

  if (userCount === 0) {
    const now = new Date().toISOString();
    const adminPass = hashPassword('Admin@123');
    const userPass = hashPassword('User@123');
    const auditorPass = hashPassword('Auditor@123');

    // 1. Admin
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_admin', 'admin', adminPass, 'ADMIN', now);

    // 2. Account Holders (Alice & Bob)
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_alice', 'alice', userPass, 'ACCOUNT_HOLDER', now);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_bob', 'bob', userPass, 'ACCOUNT_HOLDER', now);

    // 3. Auditor (Read-only)
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_auditor', 'auditor', auditorPass, 'AUDITOR', now);

    // Seed Accounts
    // Alice has Account ACC-ALICE with initial 10,000 paise (₹100.00)
    db.prepare(`
      INSERT INTO accounts (id, user_id, name, balance, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('acc_alice', 'usr_alice', "Alice's Primary Account", 10000, 'INR', now);

    // Bob has Account ACC-BOB with initial 5,000 paise (₹50.00)
    db.prepare(`
      INSERT INTO accounts (id, user_id, name, balance, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('acc_bob', 'usr_bob', "Bob's Checking Account", 5000, 'INR', now);

    // Record initial funding as legitimate system deposits so invariant holds from genesis
    const genesisTxnAlice = 'txn_genesis_alice';
    db.prepare(`
      INSERT INTO transactions (id, type, amount, from_account_id, to_account_id, actor_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'DEPOSIT', 10000, NULL, 'acc_alice', 'usr_admin', 'genesis-key-alice', 'Genesis Account Funding', 'COMPLETED', ?)
    `).run(genesisTxnAlice, now);

    // SHA256 chain genesis
    const genesisAliceId = 'led_gen_alice';
    const zeroPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const genesisAlicePayload = `${zeroPrevHash}:${genesisAliceId}:${genesisTxnAlice}:acc_alice:CREDIT:10000:10000:${now}`;
    const genesisHashAlice = createHash('sha256').update(genesisAlicePayload).digest('hex');

    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, 'acc_alice', 'CREDIT', 10000, 10000, ?, ?, ?)
    `).run(genesisAliceId, genesisTxnAlice, zeroPrevHash, genesisHashAlice, now);

    const genesisTxnBob = 'txn_genesis_bob';
    db.prepare(`
      INSERT INTO transactions (id, type, amount, from_account_id, to_account_id, actor_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'DEPOSIT', 5000, NULL, 'acc_bob', 'usr_admin', 'genesis-key-bob', 'Genesis Account Funding', 'COMPLETED', ?)
    `).run(genesisTxnBob, now);

    const genesisBobId = 'led_gen_bob';
    const genesisBobPayload = `${genesisHashAlice}:${genesisBobId}:${genesisTxnBob}:acc_bob:CREDIT:5000:5000:${now}`;
    const genesisHashBob = createHash('sha256').update(genesisBobPayload).digest('hex');

    db.prepare(`
      INSERT INTO ledger_entries (entry_id, transaction_id, account_id, direction, amount, running_balance, prev_hash, hash, created_at)
      VALUES (?, ?, 'acc_bob', 'CREDIT', 5000, 5000, ?, ?, ?)
    `).run(genesisBobId, genesisTxnBob, genesisHashAlice, genesisHashBob, now);
  }
}
