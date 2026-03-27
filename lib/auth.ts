import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from './services/jwt';
import type { AdminAllowedPage, AppId } from './auth/app-users';

function getAuthCookieName(appId: AppId): string {
  return `${appId}-token`;
}

export async function getAuthUser(
  appId: AppId = 'admin_panel',
): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const appToken = cookieStore.get(getAuthCookieName(appId))?.value;
  const legacyAdminToken =
    appId === 'admin_panel' ? cookieStore.get('admin-token')?.value : undefined;
  const token = appToken || legacyAdminToken;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.appId !== appId) return null;
  return payload;
}

export async function requireAuth(): Promise<
  { user: TokenPayload } | { error: NextResponse }
> {
  const user = await getAuthUser('admin_panel');
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

export async function requireAppAuth(
  appId: AppId,
): Promise<{ user: TokenPayload } | { error: NextResponse }> {
  const user = await getAuthUser(appId);
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

export async function requireAdminPageAccess(
  page: AdminAllowedPage,
): Promise<{ user: TokenPayload } | { error: NextResponse }> {
  const auth = await requireAuth();
  if ('error' in auth) return auth;

  const { user } = auth;
  if (user.role === 'super_admin') return auth;

  if (user.role !== 'admin' || !user.allowedPages?.includes(page)) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      ),
    };
  }

  return auth;
}
