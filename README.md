# LedgerLine — Provably Balanced Financial Ledger

> **Snovasys Fresher Hiring Challenge 2026**  
> *Money movement with a ledger you can prove.*

**LedgerLine** is a high-integrity financial ledger system designed to mathematically guarantee that money is never created, lost, or double-spent. Built with strict double-entry bookkeeping, deterministic concurrency locking to eliminate race conditions, client-driven idempotency keys for replay protection, and SHA-256 cryptographic hash-chained audit trails to prove historical immutability.

---

## 🌟 Seed Credentials for Evaluators

For instant evaluation, the platform includes one-click role switching in the header, or you can log in with:

| Role | Username | Password | Purpose / Access |
|---|---|---|---|
| **Administrator** | `admin` | `Admin@123` | Full system visibility, Conservation Invariant Monitor, System Float, Global Security Refusal Feed |
| **Account Holder (Alice)** | `alice` | `User@123` | Initial balance ₹100.00 (10,000 paise). Can transfer, deposit, withdraw, and view statements |
| **Account Holder (Bob)** | `bob` | `User@123` | Initial balance ₹50.00 (5,000 paise). Can transfer, deposit, withdraw, and view statements |
| **Auditor (Read-Only)** | `auditor` | `Auditor@123` | Read-only ledger inspection, Cryptographic SHA-256 Chain Verification, Tamper-detection |

---

## 🚀 How to Run It on Your Machine

### Prerequisites
- **Node.js**: v20 or v24 (No external database or Docker required; uses Node's zero-dependency high-concurrency engine).

### Exact Commands (In Order)

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/ledgerline.git
cd ledgerline

# 2. Install dependencies
npm install

# 3. Run the automated concurrency & invariant test suite
npm test

# 4. Start the application locally
npm run dev
```

Open your browser to: **`http://localhost:3000`**

---

## 🛡️ Mathematical Invariants & Integrity Proofs

### 1. The Conservation of Money Invariant
Internal transfers net to zero ($\Delta \text{Balance}_A + \Delta \text{Balance}_B = 0$). The total system float changes *only* via external deposits and external withdrawals:
$$\sum_{\text{All Accounts}} \text{Balance} = \sum \text{External Deposits} - \sum \text{External Withdrawals}$$
The Administrator and Auditor dashboards continuously compute this equation and verify that **Discrepancy = ₹0.00**.

### 2. Double-Entry Bookkeeping
Every transfer creates an atomic pair of ledger entries:
- **Debit Entry**: Deducts from sender's balance with running balance snapshot.
- **Credit Entry**: Credits to recipient's balance with running balance snapshot.
Both entries are committed within the exact same ACID database transaction.

### 3. Concurrency Protection & Zero Overdraws
- **Pessimistic Row Locking (`BEGIN IMMEDIATE;` / `SELECT ... FOR UPDATE`)**: Eliminates race conditions when multiple withdrawals or transfers execute simultaneously.
- **Deterministic Lock Ordering**: When transferring between two accounts, locks are always acquired in alphabetical order: $\min(\text{id}_1, \text{id}_2)$ then $\max(\text{id}_1, \text{id}_2)$, mathematically eliminating deadlocks.
- **Database-Level Constraint**: The database schema enforces `CHECK (balance >= 0)`.

### 4. Exactly-Once Idempotency
- Every transfer request accepts an `Idempotency-Key` header.
- Repeated requests with the identical key bypass money movement and return the original cached response with `isDuplicate: true`.

### 5. Cryptographic SHA-256 Hash Chaining
Every ledger entry links to the hash of the preceding entry:
$$\text{hash}_n = \text{SHA256}(\text{hash}_{n-1} + \text{entryId} + \text{txnId} + \text{accountId} + \text{direction} + \text{amount} + \text{runningBalance} + \text{timestamp})$$
If any past row is modified or deleted, the cryptographic verification engine immediately flags the tampered entry.

---

## 🧪 Automated Test Suite (`npm test`)

The test suite in `test/ledger.test.mjs` executes 5 rigorous integrity tests:

1. **Conservation Invariant Test**: Runs 20 rapid transfers between multiple accounts and proves total system float never changes.
2. **Concurrency & Overdraw Attack Test**: Fires 15 simultaneous withdrawals of 70 paise against an account with only 100 paise using `Promise.all`. Proves that **exactly 1 succeeds** and 14 fail atomically.
3. **Exactly-Once Idempotency Test**: Replays the identical transfer 3 times; verifies balances move once and duplicate requests return cached results.
4. **Server-Side Authorization Test**: Verifies that User A cannot transfer funds out of User B's account and verifies that the refusal was recorded in `refused_attempts`.
5. **Tamper Detection Test**: Injects a malicious SQL balance modification and verifies that the cryptographic auditor engine flags the corrupted row.

---

## ⚡ Interactive Attack Simulator (In the UI)

To make it easy for evaluators to test the system live without writing scripts, the web interface includes an **"Attack & Concurrency Simulator"** tab. Clicking **"Fire 10 Concurrent Attacks Now"** will:
1. Spin up a test account with ₹1.00 (100 paise).
2. Blast 10 simultaneous concurrent withdrawals of ₹0.60 each (₹6.00 total demand) in the same millisecond.
3. Display a live audit breakdown proving that **exactly 1 succeeds, 9 are rejected, and final balance is ₹0.40 with zero overdraw**.

---

## 📚 API Documentation

| Endpoint | Method | Role Required | Effect on Money / Ledger |
|---|---|---|---|
| `/api/auth/login` | `POST` | Public | Authenticates user and issues HTTP-only session cookie |
| `/api/auth/me` | `GET` | Authenticated | Returns current authenticated user and role |
| `/api/auth/logout` | `POST` | Authenticated | Clears session cookie |
| `/api/accounts` | `GET` | Authenticated | Lists accounts (owned accounts for Holder; all for Admin/Auditor) |
| `/api/transfers` | `POST` | `ACCOUNT_HOLDER`, `ADMIN` | Moves funds between two accounts; enforces double-entry, locks, and idempotency |
| `/api/deposits` | `POST` | `ACCOUNT_HOLDER`, `ADMIN` | External deposit (+Float); credits account with ledger posting |
| `/api/withdrawals` | `POST` | `ACCOUNT_HOLDER`, `ADMIN` | External withdrawal (-Float); debits account with ledger posting |
| `/api/statements/[id]` | `GET` | Account Owner, Admin, Auditor | Returns ledger entries, running balances, actors, and **refused attempts** |
| `/api/auditor/verify` | `GET` | Authenticated | Runs full SHA-256 chain verification and conservation invariant audit |
| `/api/admin/audit` | `GET` | `ADMIN`, `AUDITOR` | Returns system-wide security refusal feed and float statistics |
| `/api/simulate/attack` | `POST` | Authenticated | Runs live 10-request concurrency race attack against a test account |

---

## 📑 Required Challenge Documentation

- **[`THREATS.md`](./THREATS.md)**: Comprehensive threat model detailing 12 attack surfaces, mitigations, and accepted trade-offs.
- **[`PROMPTS.md`](./PROMPTS.md)**: Detailed engineering log tracking 5 dated AI interactions, highlighting subtle financial bugs introduced by AI and how they were corrected.
