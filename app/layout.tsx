import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LedgerLine — Provably Balanced Financial Ledger',
  description: 'Double-entry money movement engine with deterministic concurrency locking, idempotency protection, and cryptographic ledger proofs.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
