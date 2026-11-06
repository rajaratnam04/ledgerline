# LedgerLine AI Engineering & Correction Log (`PROMPTS.md`)

This log documents interactions with AI coding tools during the development of **LedgerLine**. In accordance with the challenge guidelines, this file tracks where AI generated incorrect, naive, or vulnerable code—specifically regarding financial integrity, concurrency, and cryptographic correctness—and the specific engineering interventions taken to fix them.

---

### Entry 1: 2026-11-06 — Concurrency / Audit Rollback Erasure Bug
- **What I asked the tool to do**:
  "Implement the `executeTransfer` and `executeWithdrawal` functions with balance checking, authorization checks, and audit logging into the `refused_attempts` table."
- **What the tool produced**:
  The AI placed the `logRefusal(...)` call directly inside the database transaction block right after the check failed, immediately before throwing an error:
  ```typescript
  // AI-generated naive logic:
  if (fromAcc.balance < amountPaise) {
    logRefusal(db, fromAccountId, actorUserId, 'TRANSFER', amountPaise, 'Insufficient balance');
    throw new Error('Insufficient funds');
  }
  ```
- **What was specifically wrong with it**:
  Because the error was thrown inside the transaction, the execution flowed into the `catch (err)` block, which executed `db.exec('ROLLBACK;')`. This rolled back *all* uncommitted database changes—including the `refused_attempts` insertion! The result was that every failed overdraw or unauthorized attempt silently vanished from the audit log, directly violating the requirement that every refused attempt must appear on the account statement.
- **What I did instead**:
  I decoupled refusal recording from the transactional lifecycle. I introduced a `refusalRecord` tracker within the function scope. When an invariant or authorization rule is breached, the refusal details are staged in memory. In the `catch` block, the main transaction is safely rolled back first, and the refusal is then committed independently in an autonomous write operation.
- **Commit Reference**: `e1a4b9c` (Commit: "Fix refusal audit log persistence by decoupling from transaction rollback")

---

### Entry 2: 2026-11-06 — Cryptographic Ledger Genesis Hash Discrepancy
- **What I asked the tool to do**:
  "Initialize the database schema and seed the initial funding for Alice and Bob's accounts along with their genesis ledger entries."
- **What the tool produced**:
  The AI generated password hashes using `scryptSync`, but then lazily reused `scryptSync` with random salt parameters to create the genesis hashes in `seedData`:
  ```typescript
  const genesisHashAlice = scryptSync(`GENESIS:acc_alice:10000:${now}`, 'SALT', 32).toString('hex');
  ```
- **What was specifically wrong with it**:
  The core cryptographic auditor engine (`verifyLedgerProof`) recalculates entry hashes using a deterministic `SHA-256` payload concatenation:
  $$\text{SHA256}(\text{prevHash} + \text{entryId} + \text{txnId} + \text{accountId} + \text{direction} + \text{amount} + \text{runningBalance} + \text{timestamp})$$
  Because the genesis rows were created with an ad-hoc `scrypt` string instead of the canonical `SHA-256` algorithm, the auditor verification suite flagged the entire ledger as corrupted and tampered on first startup.
- **What I did instead**:
  I eliminated the ad-hoc hashing and standardized all ledger entries—both genesis entries and runtime transaction postings—on a unified, deterministic SHA-256 hash constructor (`computeEntryHash`). The initial genesis entry links to a known 64-character zero-hash root (`0000...0000`).
- **Commit Reference**: `c3d8f1e` (Commit: "Standardize genesis seed ledger entries on canonical SHA-256 hash chain")

---

### Entry 3: 2026-11-06 — SQL Identifier vs String Literal Dialect Error in Concurrency Test
- **What I asked the tool to do**:
  "Write an automated race-condition test that sets up a victim account with 100 paise and fires 15 simultaneous withdrawals of 70 paise each."
- **What the tool produced**:
  Inside the test setup script, the AI wrote:
  ```typescript
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, "hash", "ACCOUNT_HOLDER", ?)')
    .run(victimUserId, `victim_${Date.now()}`, now);
  ```
- **What was specifically wrong with it**:
  In standard SQL and SQLite, double quotes (`"..."`) represent identifiers (table or column names), whereas single quotes (`'...'`) represent string literals. SQLite threw `Error: no such column: "hash" - should this be a string literal in single-quotes?`, immediately crashing the test suite before the race condition could be evaluated.
- **What I did instead**:
  I corrected the SQL dialect syntax to use single-quoted string literals (`'hash'`, `'ACCOUNT_HOLDER'`) and parameterized the query cleanly.
- **Commit Reference**: `a7f290d` (Commit: "Fix SQL dialect syntax quoting in automated test suite")

---

### Entry 4: 2026-11-07 — Bi-Directional Transfer Deadlock Vulnerability
- **What I asked the tool to do**:
  "Implement atomic account locking when transferring money between two accounts."
- **What the tool produced**:
  The AI suggested locking the accounts in the order provided by the caller:
  ```typescript
  // AI-suggested naive acquisition:
  const fromAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(fromAccountId);
  const toAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(toAccountId);
  ```
- **What was specifically wrong with it**:
  When User A transfers money to User B at the exact same millisecond that User B transfers money to User A, Thread 1 locks Account A and attempts to lock Account B, while Thread 2 locks Account B and attempts to lock Account A. This is a textbook circular-wait deadlock condition. Under load or in distributed configurations, this causes thread starvation and query timeouts.
- **What I did instead**:
  I rejected client-directed lock ordering and implemented **Canonical Deterministic Lock Acquisition**. When transferring between two accounts, the IDs are sorted alphabetically:
  $$\text{First lock } \min(fromId, toId), \text{ then lock } \max(fromId, toId)$$
  Regardless of the transfer direction, both concurrent requests acquire locks in the identical sequence, rendering deadlocks mathematically impossible.
- **Commit Reference**: `8b2c45f` (Commit: "Implement deterministic canonical account locking to prevent transfer deadlocks")

---

### Entry 5: 2026-11-08 — IEEE-754 Floating-Point Drift in Monetary Arithmetic
- **What I asked the tool to do**:
  "Design the account balance schema and transfer payload handling."
- **What the tool produced**:
  The AI proposed storing account balances as `REAL` / `FLOAT` in the database and accepting `amount` in decimal rupees (e.g., `10.50`), performing additions and subtractions directly in JavaScript numbers.
- **What was specifically wrong with it**:
  JavaScript numbers use IEEE-754 double-precision floating-point arithmetic. Standard operations such as `0.1 + 0.2` yield `0.30000000000000004`. Over thousands of high-frequency debit and credit cycles, fractions of a paisa accumulate or leak, eventually causing the double-entry books to fail reconciliation and violating the conservation invariant.
- **What I did instead**:
  I strictly forbade floating-point storage for monetary balances. All balances and transaction amounts are represented as whole-integer `paise` (`INTEGER` in SQLite, `BIGINT` in PostgreSQL). Any input in decimal rupees is converted to integer paise via `Math.round(rupees * 100)` at the boundary layer, and all internal ledger debits, credits, and invariant checks operate exclusively on integers.
- **Commit Reference**: `4d9e13a` (Commit: "Enforce strict whole-integer paise monetary representation to eliminate float drift")
