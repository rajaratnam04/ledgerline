import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getAccountStatement } from '@/lib/ledger';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const statement = getAccountStatement(id, user.id);
    return NextResponse.json(statement);
  } catch (err: any) {
    const status = err.message.includes('Forbidden') ? 403 : 404;
    return NextResponse.json({ error: err.message }, { status });
  }
}
