import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { executeTransfer } from '@/lib/ledger';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const idempotencyKey = request.headers.get('idempotency-key') || body.idempotencyKey;

    const { fromAccountId, toAccountId, amountPaise, amountRupees, description } = body;

    let computedPaise = amountPaise;
    if (computedPaise === undefined && amountRupees !== undefined) {
      computedPaise = Math.round(Number(amountRupees) * 100);
    }

    if (!fromAccountId || !toAccountId || !computedPaise) {
      return NextResponse.json({ error: 'Missing required transfer fields: fromAccountId, toAccountId, amount' }, { status: 400 });
    }

    const result = executeTransfer({
      fromAccountId,
      toAccountId,
      amountPaise: computedPaise,
      actorUserId: user.id,
      idempotencyKey,
      description,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    const status = err.message.includes('Forbidden') ? 403 : err.message.includes('Insufficient') ? 422 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
}
