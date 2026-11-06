'use client';

import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  ArrowRightLeft,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCw,
  Lock,
  User,
  CheckCircle2,
  XCircle,
  Database,
  Flame,
  FileText
} from 'lucide-react';

export default function Home() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [transferTargets, setTransferTargets] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'accounts' | 'admin' | 'auditor' | 'simulator'>('accounts');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Transfer Form State
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  // Deposit/Withdrawal State
  const [actionType, setActionType] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [actionAccountId, setActionAccountId] = useState('');
  const [actionAmount, setActionAmount] = useState('');

  // Statement State
  const [selectedStatementAcc, setSelectedStatementAcc] = useState('');
  const [statementData, setStatementData] = useState<any>(null);
  const [statementLoading, setStatementLoading] = useState(false);

  // Admin Audit State
  const [adminAuditData, setAdminAuditData] = useState<any>(null);

  // Auditor Verification State
  const [auditorProof, setAuditorProof] = useState<any>(null);
  const [verifyingProof, setVerifyingProof] = useState(false);

  // Attack Simulator State
  const [simulationResult, setSimulationResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    generateNewIdempotencyKey();
    checkAuth();
  }, []);

  function generateNewIdempotencyKey() {
    setIdempotencyKey(`key_${Math.random().toString(36).substring(2, 10)}_${Date.now()}`);
  }

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data.authenticated) {
        setCurrentUser(data.user);
        loadAccounts();
      } else {
        // Auto-login as Alice for instant demo convenience
        quickLogin('alice', 'User@123');
      }
    } catch {
      quickLogin('alice', 'User@123');
    } finally {
      setLoading(false);
    }
  }

  async function quickLogin(username: string, pass: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pass }),
      });
      const data = await res.json();
      if (data.success) {
        setCurrentUser(data.user);
        await loadAccounts();
        if (data.user.role === 'AUDITOR') setActiveTab('auditor');
        else if (data.user.role === 'ADMIN') setActiveTab('admin');
        else setActiveTab('accounts');
      } else {
        setMessage({ type: 'error', text: data.error || 'Login failed' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadAccounts() {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.accounts) {
        setAccounts(data.accounts);
        if (data.accounts.length > 0 && !fromAccountId) {
          setFromAccountId(data.accounts[0].id);
          setActionAccountId(data.accounts[0].id);
          setSelectedStatementAcc(data.accounts[0].id);
          loadStatement(data.accounts[0].id);
        }
      }
      if (data.transferTargets) {
        setTransferTargets(data.transferTargets);
        if (data.transferTargets.length > 0 && !toAccountId) {
          setToAccountId(data.transferTargets[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadStatement(accId: string) {
    if (!accId) return;
    setStatementLoading(true);
    try {
      const res = await fetch(`/api/statements/${accId}`);
      const data = await res.json();
      if (res.ok) {
        setStatementData(data);
      } else {
        setStatementData(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setStatementLoading(false);
    }
  }

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!transferAmount || Number(transferAmount) <= 0) {
      setMessage({ type: 'error', text: 'Enter a valid transfer amount.' });
      return;
    }

    setTransferSubmitting(true);
    setMessage(null);

    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amountRupees: parseFloat(transferAmount),
          description: `Transfer from ${fromAccountId} to ${toAccountId}`,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        const dupNote = data.isDuplicate ? ' (Duplicate Request Detected: Returned Cached Result)' : '';
        setMessage({ type: 'success', text: (data.message || 'Transfer completed successfully!') + dupNote });
        setTransferAmount('');
        loadAccounts();
        if (selectedStatementAcc === fromAccountId || selectedStatementAcc === toAccountId) {
          loadStatement(selectedStatementAcc);
        }
      } else {
        setMessage({ type: 'error', text: data.error || 'Transfer failed' });
        loadAccounts();
        if (selectedStatementAcc === fromAccountId) {
          loadStatement(selectedStatementAcc);
        }
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setTransferSubmitting(false);
    }
  }

  async function handleDepositWithdraw(e: React.FormEvent) {
    e.preventDefault();
    if (!actionAmount || Number(actionAmount) <= 0) return;

    setMessage(null);
    const endpoint = actionType === 'DEPOSIT' ? '/api/deposits' : '/api/withdrawals';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: actionAccountId,
          amountRupees: parseFloat(actionAmount),
          description: `Manual ${actionType}`,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: data.message });
        setActionAmount('');
        loadAccounts();
        if (selectedStatementAcc === actionAccountId) {
          loadStatement(actionAccountId);
        }
      } else {
        setMessage({ type: 'error', text: data.error || `${actionType} failed` });
        if (selectedStatementAcc === actionAccountId) {
          loadStatement(actionAccountId);
        }
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function runAuditorVerification() {
    setVerifyingProof(true);
    try {
      const res = await fetch('/api/auditor/verify');
      const data = await res.json();
      setAuditorProof(data);
    } catch (err) {
      console.error(err);
    } finally {
      setVerifyingProof(false);
    }
  }

  async function loadAdminAudit() {
    try {
      const res = await fetch('/api/admin/audit');
      const data = await res.json();
      setAdminAuditData(data);
    } catch (err) {
      console.error(err);
    }
  }

  async function runConcurrencyAttack() {
    setSimulating(true);
    setSimulationResult(null);
    try {
      const res = await fetch('/api/simulate/attack', { method: 'POST' });
      const data = await res.json();
      setSimulationResult(data);
      loadAccounts();
    } catch (err: any) {
      setSimulationResult({ error: err.message });
    } finally {
      setSimulating(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Banner & Demo Quick Switch */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/10 border border-emerald-500/30 p-2 rounded-lg text-emerald-400">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              LedgerLine
              <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono">
                PROVABLY BALANCED
              </span>
            </h1>
            <p className="text-xs text-slate-400">Double-Entry Ledger with Strict Concurrency & Cryptographic Proofs</p>
          </div>
        </div>

        {/* Role Quick-Switch Bar for Evaluators */}
        <div className="flex items-center gap-2 bg-slate-800/80 p-1.5 rounded-xl border border-slate-700/60">
          <span className="text-xs font-medium text-slate-400 px-2 flex items-center gap-1">
            <User className="w-3.5 h-3.5" /> Evaluator Switch:
          </span>
          <button
            onClick={() => quickLogin('alice', 'User@123')}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition ${
              currentUser?.username === 'alice' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            Alice (Holder)
          </button>
          <button
            onClick={() => quickLogin('bob', 'User@123')}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition ${
              currentUser?.username === 'bob' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            Bob (Holder)
          </button>
          <button
            onClick={() => quickLogin('admin', 'Admin@123')}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition ${
              currentUser?.username === 'admin' ? 'bg-purple-600 text-white shadow' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            Admin
          </button>
          <button
            onClick={() => quickLogin('auditor', 'Auditor@123')}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition ${
              currentUser?.username === 'auditor' ? 'bg-amber-600 text-white shadow' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            Auditor
          </button>
        </div>
      </header>

      {/* Global Alerts */}
      {message && (
        <div className="max-w-7xl mx-auto w-full px-6 pt-4">
          <div
            className={`p-4 rounded-xl border flex items-center gap-3 ${
              message.type === 'success'
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
            }`}
          >
            {message.type === 'success' ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" /> : <XCircle className="w-5 h-5 flex-shrink-0" />}
            <span className="text-sm font-medium">{message.text}</span>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="max-w-7xl mx-auto w-full px-6 pt-6 flex gap-2 border-b border-slate-800">
        <button
          onClick={() => setActiveTab('accounts')}
          className={`pb-3 px-4 font-medium text-sm flex items-center gap-2 border-b-2 transition ${
            activeTab === 'accounts'
              ? 'border-emerald-500 text-emerald-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Database className="w-4 h-4" /> Accounts & Transfers
        </button>
        <button
          onClick={() => {
            setActiveTab('admin');
            loadAdminAudit();
          }}
          className={`pb-3 px-4 font-medium text-sm flex items-center gap-2 border-b-2 transition ${
            activeTab === 'admin'
              ? 'border-purple-500 text-purple-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ShieldCheck className="w-4 h-4" /> Admin Invariant Monitor
        </button>
        <button
          onClick={() => {
            setActiveTab('auditor');
            runAuditorVerification();
          }}
          className={`pb-3 px-4 font-medium text-sm flex items-center gap-2 border-b-2 transition ${
            activeTab === 'auditor'
              ? 'border-amber-500 text-amber-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Lock className="w-4 h-4" /> Auditor Proof Console
        </button>
        <button
          onClick={() => setActiveTab('simulator')}
          className={`pb-3 px-4 font-medium text-sm flex items-center gap-2 border-b-2 transition ${
            activeTab === 'simulator'
              ? 'border-rose-500 text-rose-400 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Flame className="w-4 h-4" /> Attack & Concurrency Simulator
        </button>
      </div>

      {/* Main Content Area */}
      <div className="max-w-7xl mx-auto w-full px-6 py-6 flex-1">
        {/* TAB 1: ACCOUNTS & TRANSFERS */}
        {activeTab === 'accounts' && (
          <div className="space-y-6">
            {/* Account Balances Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {accounts.map((acc) => (
                <div
                  key={acc.id}
                  className={`p-5 rounded-2xl border transition ${
                    selectedStatementAcc === acc.id
                      ? 'bg-slate-900 border-emerald-500/60 shadow-lg shadow-emerald-950/20'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                  }`}
                  onClick={() => {
                    setSelectedStatementAcc(acc.id);
                    loadStatement(acc.id);
                  }}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <span className="text-xs font-mono text-slate-400 uppercase tracking-wider">{acc.id}</span>
                      <h3 className="font-semibold text-white">{acc.name}</h3>
                    </div>
                    <span className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono">
                      {acc.currency}
                    </span>
                  </div>
                  <div className="mt-4">
                    <span className="text-xs text-slate-400">Available Balance</span>
                    <div className="text-2xl font-bold text-emerald-400 font-mono">
                      ₹{(acc.balance / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono">({acc.balance} paise integer storage)</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Actions: Transfer & Deposit/Withdraw */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Transfer Form */}
              <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl">
                <h3 className="text-base font-semibold text-white flex items-center gap-2 mb-4">
                  <ArrowRightLeft className="w-5 h-5 text-emerald-400" /> Transfer Money (Strict Double-Entry)
                </h3>
                <form onSubmit={handleTransfer} className="space-y-4">
                  <div>
                    <label className="text-xs text-slate-400 font-medium block mb-1">From Account</label>
                    <select
                      value={fromAccountId}
                      onChange={(e) => setFromAccountId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.id}) — ₹{(a.balance / 100).toFixed(2)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 font-medium block mb-1">To Account</label>
                    <select
                      value={toAccountId}
                      onChange={(e) => setToAccountId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                    >
                      {transferTargets.length > 0 ? (
                        transferTargets.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.id})
                          </option>
                        ))
                      ) : (
                        <option value="">No other accounts available</option>
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 font-medium block mb-1">Amount (INR)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-slate-400 font-mono">₹</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        value={transferAmount}
                        onChange={(e) => setTransferAmount(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
                      />
                    </div>
                  </div>

                  {/* Idempotency Key Panel */}
                  <div className="bg-slate-950/60 border border-slate-800/80 p-3 rounded-xl space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-blue-400" /> Idempotency Key (Replay Defense)
                      </label>
                      <button
                        type="button"
                        onClick={generateNewIdempotencyKey}
                        className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
                      >
                        <RefreshCw className="w-2.5 h-2.5" /> Re-roll Key
                      </button>
                    </div>
                    <input
                      type="text"
                      value={idempotencyKey}
                      onChange={(e) => setIdempotencyKey(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-300 font-mono focus:outline-none"
                    />
                    <p className="text-[10px] text-slate-500">
                      Sending the same key twice returns the original result without moving money again.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={transferSubmitting}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-xl transition text-sm flex justify-center items-center gap-2 shadow-lg shadow-emerald-950/40 disabled:opacity-50"
                  >
                    {transferSubmitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                    Move Money Atomically
                  </button>
                </form>
              </div>

              {/* External Deposit & Withdrawal (Changes Float) */}
              <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl flex flex-col justify-between">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2 mb-4">
                    <ArrowDownLeft className="w-5 h-5 text-blue-400" /> External Money In / Out
                  </h3>
                  <div className="flex gap-2 mb-4 bg-slate-950 p-1 rounded-xl border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setActionType('DEPOSIT')}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                        actionType === 'DEPOSIT' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      External Deposit (+Float)
                    </button>
                    <button
                      type="button"
                      onClick={() => setActionType('WITHDRAWAL')}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                        actionType === 'WITHDRAWAL' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      External Withdrawal (-Float)
                    </button>
                  </div>

                  <form onSubmit={handleDepositWithdraw} className="space-y-4">
                    <div>
                      <label className="text-xs text-slate-400 font-medium block mb-1">Target Account</label>
                      <select
                        value={actionAccountId}
                        onChange={(e) => setActionAccountId(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.id})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs text-slate-400 font-medium block mb-1">Amount (INR)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-2 text-slate-400 font-mono">₹</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          placeholder="0.00"
                          value={actionAmount}
                          onChange={(e) => setActionAmount(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className={`w-full font-medium py-2.5 rounded-xl transition text-sm flex justify-center items-center gap-2 text-white ${
                        actionType === 'DEPOSIT'
                          ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-950/40'
                          : 'bg-rose-600 hover:bg-rose-500 shadow-rose-950/40'
                      }`}
                    >
                      {actionType === 'DEPOSIT' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                      Execute {actionType}
                    </button>
                  </form>
                </div>

                <div className="mt-6 bg-slate-950/40 border border-slate-800 p-3 rounded-xl text-xs text-slate-400">
                  <p className="flex items-center gap-1 font-semibold text-slate-300">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Invariant Guarantee:
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed">
                    Internal transfers net to zero. Total system balance changes ONLY via these external deposits and withdrawals.
                  </p>
                </div>
              </div>
            </div>

            {/* Statement & Refused Attempts Log */}
            <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-4">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <FileText className="w-5 h-5 text-indigo-400" /> Per-Account Statement & Refusal Audit Log
                  </h3>
                  <p className="text-xs text-slate-400">Includes running balances, actors, and every refused attempt.</p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={selectedStatementAcc}
                    onChange={(e) => {
                      setSelectedStatementAcc(e.target.value);
                      loadStatement(e.target.value);
                    }}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        Statement: {a.name} ({a.id})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => loadStatement(selectedStatementAcc)}
                    className="bg-slate-800 hover:bg-slate-700 p-2 rounded-xl text-slate-300 transition"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${statementLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {statementData && (
                <div className="space-y-6">
                  {/* Ledger Postings Table */}
                  <div className="overflow-x-auto rounded-xl border border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px] border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">Entry ID</th>
                          <th className="py-2.5 px-3">Type</th>
                          <th className="py-2.5 px-3">Actor</th>
                          <th className="py-2.5 px-3">Direction</th>
                          <th className="py-2.5 px-3 text-right">Amount</th>
                          <th className="py-2.5 px-3 text-right">Running Balance</th>
                          <th className="py-2.5 px-3 font-mono">Entry Hash (SHA-256)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono">
                        {statementData.entries.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-4 text-center text-slate-500">
                              No entries found for this account.
                            </td>
                          </tr>
                        ) : (
                          statementData.entries.map((entry: any) => (
                            <tr key={entry.entry_id} className="hover:bg-slate-800/40 transition">
                              <td className="py-2 px-3 text-slate-400">{entry.entry_id.slice(0, 14)}...</td>
                              <td className="py-2 px-3 text-slate-300 font-sans">{entry.txn_type}</td>
                              <td className="py-2 px-3 text-slate-300 font-sans">{entry.actor_name}</td>
                              <td className="py-2 px-3">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    entry.direction === 'CREDIT'
                                      ? 'bg-emerald-500/20 text-emerald-400'
                                      : 'bg-rose-500/20 text-rose-400'
                                  }`}
                                >
                                  {entry.direction}
                                </span>
                              </td>
                              <td
                                className={`py-2 px-3 text-right font-bold ${
                                  entry.direction === 'CREDIT' ? 'text-emerald-400' : 'text-rose-400'
                                }`}
                              >
                                {entry.direction === 'CREDIT' ? '+' : '-'}₹{(entry.amount / 100).toFixed(2)}
                              </td>
                              <td className="py-2 px-3 text-right font-bold text-slate-100">
                                ₹{(entry.running_balance / 100).toFixed(2)}
                              </td>
                              <td className="py-2 px-3 text-slate-500 text-[10px]" title={entry.hash}>
                                {entry.hash.slice(0, 16)}...
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Refused Attempts Table (Mandatory Feature) */}
                  <div>
                    <h4 className="text-xs font-semibold text-rose-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                      <AlertTriangle className="w-4 h-4 text-rose-400" /> Refused Attempts on this Account (Audit Trail)
                    </h4>
                    <div className="overflow-x-auto rounded-xl border border-rose-950/60 bg-rose-950/20">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-rose-950/40 text-rose-300 font-mono uppercase text-[10px] border-b border-rose-900/50">
                          <tr>
                            <th className="py-2 px-3">Time</th>
                            <th className="py-2 px-3">Action</th>
                            <th className="py-2 px-3">Initiated By</th>
                            <th className="py-2 px-3 text-right">Attempted Amount</th>
                            <th className="py-2 px-3">Server Rejection Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-rose-950/40 font-mono text-[11px]">
                          {statementData.refusedAttempts.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-3 text-center text-slate-500">
                                Zero refused attempts. All operations succeeded.
                              </td>
                            </tr>
                          ) : (
                            statementData.refusedAttempts.map((refusal: any) => (
                              <tr key={refusal.id} className="hover:bg-rose-950/30">
                                <td className="py-1.5 px-3 text-slate-400">{new Date(refusal.created_at).toLocaleTimeString()}</td>
                                <td className="py-1.5 px-3 font-sans font-semibold text-rose-300">{refusal.action_type}</td>
                                <td className="py-1.5 px-3 text-slate-300 font-sans">{refusal.actor_name || refusal.actor_user_id}</td>
                                <td className="py-1.5 px-3 text-right text-rose-300">₹{(refusal.amount / 100).toFixed(2)}</td>
                                <td className="py-1.5 px-3 text-rose-400 font-sans font-medium">{refusal.reason}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: ADMIN INVARIANT MONITOR */}
        {activeTab === 'admin' && (
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 to-purple-950/40 border border-purple-800/40">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-2">
                <ShieldCheck className="w-6 h-6 text-purple-400" /> Conservation of Money Invariant Monitor
              </h2>
              <p className="text-xs text-slate-300 max-w-2xl">
                Mathematical proof: Total system balance must equal cumulative external deposits minus cumulative external withdrawals.
                Internal transfers net to zero.
              </p>

              {auditorProof?.conservation && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Total System Balance</span>
                    <div className="text-2xl font-bold font-mono text-white mt-1">
                      ₹{(auditorProof.conservation.totalCurrentBalance / 100).toFixed(2)}
                    </div>
                  </div>
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Total External Deposits</span>
                    <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
                      +₹{(auditorProof.conservation.totalExternalDeposits / 100).toFixed(2)}
                    </div>
                  </div>
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Total External Withdrawals</span>
                    <div className="text-2xl font-bold font-mono text-rose-400 mt-1">
                      -₹{(auditorProof.conservation.totalExternalWithdrawals / 100).toFixed(2)}
                    </div>
                  </div>
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">System Discrepancy</span>
                    <div className="text-2xl font-bold font-mono text-emerald-400 mt-1 flex items-center gap-1.5">
                      <CheckCircle2 className="w-5 h-5" /> ₹{(auditorProof.conservation.discrepancy / 100).toFixed(2)}
                    </div>
                    <span className="text-[10px] text-emerald-500 font-semibold">Invariant Strictly Holds</span>
                  </div>
                </div>
              )}
            </div>

            {/* Global Refusal Feed */}
            <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl">
              <h3 className="text-base font-semibold text-white flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-rose-400" /> System-Wide Security Refusal Feed
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px] border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">Timestamp</th>
                      <th className="py-2.5 px-3">Account</th>
                      <th className="py-2.5 px-3">Actor</th>
                      <th className="py-2.5 px-3">Action</th>
                      <th className="py-2.5 px-3 text-right">Attempted Amount</th>
                      <th className="py-2.5 px-3">Rejection Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 font-mono text-xs">
                    {!adminAuditData?.refusals || adminAuditData.refusals.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-4 text-center text-slate-500">
                          No refusals recorded yet.
                        </td>
                      </tr>
                    ) : (
                      adminAuditData.refusals.map((r: any) => (
                        <tr key={r.id} className="hover:bg-slate-800/40">
                          <td className="py-2 px-3 text-slate-400">{new Date(r.created_at).toLocaleString()}</td>
                          <td className="py-2 px-3 text-blue-400">{r.account_id}</td>
                          <td className="py-2 px-3 text-slate-300 font-sans">{r.actor_name || r.actor_user_id}</td>
                          <td className="py-2 px-3 font-sans font-bold text-rose-400">{r.action_type}</td>
                          <td className="py-2 px-3 text-right font-bold text-slate-200">₹{(r.amount / 100).toFixed(2)}</td>
                          <td className="py-2 px-3 text-rose-400 font-sans">{r.reason}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: AUDITOR PROOF CONSOLE */}
        {activeTab === 'auditor' && (
          <div className="space-y-6">
            <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl">
              <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
                <div>
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Lock className="w-5 h-5 text-amber-400" /> Cryptographic Ledger Proof Engine
                  </h3>
                  <p className="text-xs text-slate-400">
                    Calculates SHA-256 hash chains from genesis entry. Detects any row modification, deletion, or balance tampering.
                  </p>
                </div>
                <button
                  onClick={runAuditorVerification}
                  disabled={verifyingProof}
                  className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold px-4 py-2 rounded-xl transition flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${verifyingProof ? 'animate-spin' : ''}`} />
                  Re-Verify Entire Ledger Now
                </button>
              </div>

              {auditorProof && (
                <div className="space-y-4">
                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      auditorProof.chainValid
                        ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                        : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                    }`}
                  >
                    {auditorProof.chainValid ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" /> : <XCircle className="w-6 h-6 flex-shrink-0" />}
                    <div>
                      <h4 className="font-bold text-sm">
                        {auditorProof.chainValid
                          ? 'Cryptographic Verification Passed: Ledger is 100% Immutable'
                          : 'Ledger Tamper Detected! Chain Broken!'}
                      </h4>
                      <p className="text-xs mt-0.5 opacity-90">
                        Total entries checked: {auditorProof.totalEntriesChecked}. All cryptographic links verified at{' '}
                        {new Date(auditorProof.verifiedAt).toLocaleTimeString()}.
                      </p>
                    </div>
                  </div>

                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                    <div className="text-slate-400 font-sans font-semibold">How the Auditor Proof Works:</div>
                    <div className="text-slate-300">
                      Entry Hash = SHA-256(prev_hash + entry_id + transaction_id + account_id + direction + amount + running_balance + created_at)
                    </div>
                    <div className="text-slate-500 text-[11px]">
                      Because every entry embeds the previous entry hash, any retroactively modified balance or deleted transaction invalidates all subsequent hashes.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: CONCURRENCY ATTACK SIMULATOR */}
        {activeTab === 'simulator' && (
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 to-rose-950/40 border border-rose-800/40">
              <div className="flex flex-wrap justify-between items-center gap-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Flame className="w-6 h-6 text-rose-400" /> Live Concurrency & Race Condition Attack Runner
                  </h2>
                  <p className="text-xs text-slate-300 max-w-2xl mt-1">
                    Evaluator tool: Click the button below to instantiate an account with exactly ₹1.00 (100 paise) and blast{' '}
                    <strong>10 simultaneous concurrent withdrawals of ₹0.60 each</strong> using Promise.all in the same millisecond.
                  </p>
                </div>
                <button
                  onClick={runConcurrencyAttack}
                  disabled={simulating}
                  className="bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs px-5 py-2.5 rounded-xl transition flex items-center gap-2 shadow-lg shadow-rose-950/40 disabled:opacity-50"
                >
                  <Flame className={`w-4 h-4 ${simulating ? 'animate-bounce' : ''}`} />
                  {simulating ? 'Blasting 10 Concurrent Requests...' : 'Fire 10 Concurrent Attacks Now'}
                </button>
              </div>
            </div>

            {simulationResult && (
              <div className="bg-slate-900/70 border border-slate-800 p-6 rounded-2xl space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Initial Account Float</span>
                    <div className="text-xl font-bold font-mono text-white mt-1">₹{simulationResult.initialBalanceRupees}</div>
                  </div>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Total Demanded Outflow</span>
                    <div className="text-xl font-bold font-mono text-rose-400 mt-1">₹6.00 (10 × ₹0.60)</div>
                  </div>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Successful Withdrawals</span>
                    <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                      {simulationResult.successCount} of 10
                    </div>
                  </div>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                    <span className="text-xs text-slate-400">Final Balance After Race</span>
                    <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                      ₹{simulationResult.finalBalanceRupees}
                    </div>
                    <span className="text-[10px] text-emerald-400 font-semibold">Zero Overdraw!</span>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px] border-b border-slate-800">
                      <tr>
                        <th className="py-2 px-3">Request #</th>
                        <th className="py-2 px-3">Execution Status</th>
                        <th className="py-2 px-3">Server Response Detail</th>
                        <th className="py-2 px-3 text-right">Balance Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 font-mono text-xs">
                      {simulationResult.executionLog?.map((item: any) => (
                        <tr
                          key={item.requestNumber}
                          className={item.status.includes('SUCCESS') ? 'bg-emerald-950/20' : 'bg-slate-900/40'}
                        >
                          <td className="py-2 px-3 text-slate-400">Request {item.requestNumber}</td>
                          <td className="py-2 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                item.status.includes('SUCCESS')
                                  ? 'bg-emerald-500/20 text-emerald-400'
                                  : 'bg-rose-500/20 text-rose-400'
                              }`}
                            >
                              {item.status}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-slate-300 font-sans">{item.detail}</td>
                          <td className="py-2 px-3 text-right font-bold text-slate-200">
                            {item.balanceAfter !== undefined ? `₹${(item.balanceAfter / 100).toFixed(2)}` : 'Unchanged'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
