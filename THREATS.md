# LedgerLine Threat Model & Attack Vector Analysis (`THREATS.md`)

This document details the attack surfaces, concurrency vulnerabilities, and fraud vectors considered during the engineering of **LedgerLine**, how each threat is closed, which automated tests prove it, and which trade-offs were consciously accepted.

---

## 1. Concurrency & Race Condition Attacks

### Threat 1.1: Race Condition Overdraw (Double-Spend at the Millisecond Boundary)
- **The Attack**: An attacker with ₹100.00 (10,000 paise) fires 10 simultaneous HTTP withdrawal or transfer requests of ₹80.00 each across multiple threads/connections. In naive application architectures where balance is read, validated in memory, and then written (`SELECT balance ...; if (bal >= amt) UPDATE accounts ...;`), all 10 requests read the initial ₹100.00, approve the withdrawal, and drive the account to -₹700.00.
- **How We Closed It**:
  1. **Pessimistic Write-Exclusive Locking**: Transactions execute with SQLite `BEGIN IMMEDIATE;` (or PostgreSQL `SELECT ... FOR UPDATE`), ensuring that once a transaction enters its critical balance-checking section, no concurrent transaction can modify or read uncommitted states.
  2. **Database-Level Hard Invariant**: The database schema enforces `CHECK (balance >= 0)`. Even if application-level logic were completely bypassed or corrupted, the database engine physically rejects any write that would result in a negative balance.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 2), which fires 15 concurrent withdrawals of 70 paise against an account with 100 paise. Exactly 1 succeeds, 14 are atomically rejected, and the final balance is 30 paise. Also exposed in the UI via the interactive "Attack & Concurrency Simulator".

### Threat 1.2: Bi-Directional Transfer Deadlocks
- **The Attack**: User A transfers money to User B while User B simultaneously transfers money to User A. If Thread 1 locks Account A and waits for Account B, while Thread 2 locks Account B and waits for Account A, the database deadlocks, causing timeout failures or hanging connections.
- **How We Closed It**:
  - **Deterministic Lock Acquisition Order**: We enforce global canonical ordering when acquiring locks. When transferring between Account $X$ and Account $Y$, the application always sorts the IDs:
    $$\text{Lock } \min(X, Y) \text{ first, then lock } \max(X, Y)$$
    Because all concurrent threads acquire locks in the exact same sequence, circular wait is mathematically eliminated ($P(\text{deadlock}) = 0$).
- **Accepted Risk / Trade-Off**: Sorting by string ID introduces a negligible CPU sort overhead ($\sim 1 \mu s$) for 2 elements, which is vastly outweighed by deadlock prevention.

---

## 2. Idempotency & Replay Attacks

### Threat 2.1: Network Timeout Replay & Double-Click Duplicate Charges
- **The Attack**: A client initiates a ₹500 payment. The server processes the debit and credits the vendor, but the client’s Wi-Fi drops before receiving the HTTP 200 response. The browser or client payment SDK automatically retries the request 3 seconds later. Without idempotency protection, the vendor is paid twice (₹1,000 total).
- **How We Closed It**:
  - **Client-Driven Idempotency Keys**: All money-moving endpoints accept an `Idempotency-Key` HTTP header.
  - **State-Tracked Idempotency Table**:
    1. On first receipt, the key is inserted with `status: PENDING` and a SHA-256 hash of the request payload.
    2. If a duplicate key arrives while the original is `PENDING`, the server rejects the concurrent attempt (409 Conflict) to prevent racing duplicate requests.
    3. Once completed, the final HTTP status code and response payload are persisted in `idempotency_records`.
    4. Any subsequent replay with the same key bypasses the money movement engine entirely and immediately returns the cached original response with `isDuplicate: true`.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 3), which plays the identical transfer 3 times; balances move exactly once.

---

## 3. Financial Integrity & Invariant Preservation

### Threat 3.1: Float Leakage & IEEE-754 Precision Loss
- **The Attack**: Systems using standard floating-point numbers (`0.1 + 0.2 = 0.30000000000000004`) accumulate tiny fractional errors over thousands of transactions, causing the ledger to drift and fail reconciliation.
- **How We Closed It**:
  - **Whole Integer Paise Arithmetic**: All balances, debits, credits, and limits are stored and manipulated as integers in paise (`₹1.00 = 100 paise`). Floats are strictly prohibited in the database and core ledger engine.
- **Accepted Risk / Trade-Off**: Any display in Rupees requires dividing by 100 on the presentation layer, but internal bookkeeping remains 100% exact.

### Threat 3.2: Conservation Invariant Violation (Money Creation / Destruction)
- **The Attack**: A transfer debits Account A, but an unhandled exception occurs before Account B is credited, destroying funds. Or external deposits are credited without an audit trail, creating unbacked money out of thin air.
- **How We Closed It**:
  - **Strict Double-Entry Bookkeeping**: Internal transfers write 1 DEBIT and 1 CREDIT entry within the same atomic ACID transaction. If either fails, the entire transaction rolls back.
  - **Conservation Theorem**:
    $$\sum \text{All Account Balances} = \sum \text{External Deposits} - \sum \text{External Withdrawals}$$
  - The Admin and Auditor consoles execute a real-time invariant audit verifying that the system float discrepancy is exactly ₹0.00.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 1) across 20 rapid cross-account transfers.

---

## 4. Ledger Tamper-Resistance & Auditability

### Threat 4.1: Covert Ledger Alteration or Row Deletion
- **The Attack**: A rogue administrator, compromised database credential, or SQL injection silently modifies a past ledger entry to conceal embezzlement or delete an unauthorized withdrawal.
- **How We Closed It**:
  - **Cryptographic SHA-256 Hash Chaining**: Every ledger entry embeds the hash of the preceding ledger entry:
    $$\text{hash}_n = \text{SHA256}(\text{hash}_{n-1} + \text{entryId} + \text{txnId} + \text{accountId} + \text{direction} + \text{amount} + \text{runningBalance} + \text{timestamp})$$
  - If any row is altered or deleted, every subsequent entry's `prev_hash` is invalidated.
  - The Auditor console provides a one-click verification tool that recomputes the chain from genesis and immediately flags any altered row and the exact entry ID where tampering occurred.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 5), where an injected balance alteration immediately triggers cryptographic verification failure.

### Threat 4.2: Missing Audit Trail for Refused / Fraudulent Attempts
- **The Attack**: An attacker tries to guess account IDs or probe transfer limits. If the server only returns HTTP 403 or 422 without recording the failure, security auditors have no visibility into attack reconnaissance.
- **How We Closed It**:
  - **Autonomous Refusal Logging (`refused_attempts`)**: Whenever an authorization check fails or an overdraw is attempted, an immutable refusal record is committed with the actor ID, target account, attempted amount, and server rejection reason.
  - **Transaction Rollback Decoupling**: Crucially, refusal logs are committed *independently* of the failed transaction so that a database rollback does not erase the security audit trail.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 4).

---

## 5. Authorization & Privilege Escalation

### Threat 5.1: Payload Account Spoofing
- **The Attack**: User A authenticates legitimately, but crafts a malicious POST request to `/api/transfers` with `fromAccountId: "acc_bob"` to steal funds from User B.
- **How We Closed It**:
  - **Server-Side Ownership Enforcement**: The server queries the authenticated user session from the signed, HTTP-only cookie, and verifies that `fromAcc.user_id === session.userId` (unless the user holds the verified `ADMIN` role). Client-supplied ownership claims are ignored.
- **Verification / Test**: Covered by `test/ledger.test.mjs` (Invariant 4).

---

## 6. Summary of Accepted Risks & Future Mitigations

| Threat Vector | Current Status | Accepted Reason / Future Roadmap |
|---|---|---|
| **Distributed Multi-Region Concurrency** | Closed for single-database instances via row/table write locking | In a distributed multi-region database setup, global serializability requires distributed consensus (e.g. Spanner TrueTime or Raft-based state machines). For this 7-day challenge, ACID single-node database locking is optimal and defended. |
| **Idempotency Key Expiry Pruning** | Closed (keys retained indefinitely) | In production high-volume ledgers, keys are pruned after 30–90 days with a Redis TTL. For challenge demonstration, retaining all keys ensures lifetime replay auditability. |
