import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from './services/jwt';

export async function getAuthUser(): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin-token')?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function requireAuth(): Promise<
  { user: TokenPayload } | { error: NextResponse }
> {
  const user = await getAuthUser();
  if (!user) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      ),
    };
  }
  return { user };
}
