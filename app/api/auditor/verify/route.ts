import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { verifyLedgerProof } from '@/lib/ledger';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Any authenticated user can view the mathematical proof of ledger integrity
  const proof = verifyLedgerProof();
  return NextResponse.json(proof);
}
