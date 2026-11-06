import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { executeDeposit } from '@/lib/ledger';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const idempotencyKey = request.headers.get('idempotency-key') || body.idempotencyKey;
    const { accountId, amountPaise, amountRupees, description } = body;

    let computedPaise = amountPaise;
    if (computedPaise === undefined && amountRupees !== undefined) {
      computedPaise = Math.round(Number(amountRupees) * 100);
    }

    if (!accountId || !computedPaise) {
      return NextResponse.json({ error: 'Missing accountId or amount' }, { status: 400 });
    }

    const result = executeDeposit({
      accountId,
      amountPaise: computedPaise,
      actorUserId: user.id,
      idempotencyKey,
      description,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
