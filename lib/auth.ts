import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from './services/jwt';
import {
  ADMIN_ALLOWED_PAGES,
  type AdminAllowedPage,
  type AppId,
} from './auth/app-users';
import { connectDB } from './db';
import User from './models/User';

const ADMIN_PAGE_SET = new Set<string>([...ADMIN_ALLOWED_PAGES, 'users']);

function normalizeAdminAllowedPages(
  pages: unknown,
): Array<AdminAllowedPage | 'users'> {
  if (!Array.isArray(pages)) return [];

  return pages.filter(
    (page): page is AdminAllowedPage | 'users' =>
      typeof page === 'string' && ADMIN_PAGE_SET.has(page),
  );
}

function hasAdminPageAccess(
  page: AdminAllowedPage,
  pages: Array<AdminAllowedPage | 'users'>,
): boolean {
  return pages.includes(page) || (page === 'admins' && pages.includes('users'));
}

function forbiddenResponse() {
  return NextResponse.json(
    { success: false, error: 'Forbidden' },
    { status: 403 },
  );
}

function getAuthCookieName(appId: AppId): string {
  return `${appId}-token`;
}

export async function getAuthUser(
  appId: AppId = 'admin_panel',
): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(getAuthCookieName(appId))?.value;

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

  const tokenAllowedPages = normalizeAdminAllowedPages(user.allowedPages);
  if (user.role === 'admin' && hasAdminPageAccess(page, tokenAllowedPages)) {
    return auth;
  }

  // Token permissions can be stale after role/page updates.
  // Re-check against DB so access changes apply immediately.
  try {
    await connectDB();
    const freshUser = await User.findById(user.userId)
      .select('role allowedPages')
      .lean();

    if (!freshUser) {
      return { error: forbiddenResponse() };
    }

    if (freshUser.role === 'super_admin') {
      return {
        user: {
          ...user,
          role: 'super_admin',
          allowedPages: normalizeAdminAllowedPages(freshUser.allowedPages),
        },
      };
    }

    const freshAllowedPages = normalizeAdminAllowedPages(
      freshUser.allowedPages,
    );
    if (
      freshUser.role === 'admin' &&
      hasAdminPageAccess(page, freshAllowedPages)
    ) {
      return {
        user: {
          ...user,
          role: 'admin',
          allowedPages: freshAllowedPages,
        },
      };
    }
  } catch (error) {
    console.error('Error validating admin page access:', error);
  }

  return { error: forbiddenResponse() };
}
