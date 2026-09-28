import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from './services/jwt';
import {
  ADMIN_ALLOWED_PAGES,
  ADMIN_ALLOWED_ACTIONS,
  type AdminAllowedPage,
  type AdminAllowedAction,
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
  page: AdminAllowedPage | AdminAllowedPage[],
  pages: Array<AdminAllowedPage | 'users'>,
): boolean {
  const targetPages = Array.isArray(page) ? page : [page];
  return targetPages.some(
    (p) => pages.includes(p) || (p === 'admins' && pages.includes('users')),
  );
}

const ADMIN_ACTION_SET = new Set<string>(ADMIN_ALLOWED_ACTIONS);

function normalizeAdminAllowedActions(
  actions: unknown,
): AdminAllowedAction[] {
  if (!Array.isArray(actions)) return [];

  return actions.filter(
    (action): action is AdminAllowedAction =>
      typeof action === 'string' && ADMIN_ACTION_SET.has(action),
  );
}

function hasAdminAction(
  action: AdminAllowedAction,
  allowedActions: unknown,
  allowedPages: unknown,
): boolean {
  // Legacy: these actions used to live in `allowedPages`. Accept them there
  // too so existing admins keep access until their record is re-saved.
  return (
    normalizeAdminAllowedActions(allowedActions).includes(action) ||
    (Array.isArray(allowedPages) && allowedPages.includes(action))
  );
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
  page: AdminAllowedPage | AdminAllowedPage[],
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

export async function requireAdminAction(
  action: AdminAllowedAction,
): Promise<{ user: TokenPayload } | { error: NextResponse }> {
  const auth = await requireAuth();
  if ('error' in auth) return auth;

  const { user } = auth;
  if (user.role === 'super_admin') return auth;

  if (
    user.role === 'admin' &&
    hasAdminAction(action, user.allowedActions, user.allowedPages)
  ) {
    return auth;
  }

  // Token permissions can be stale after role/action updates.
  // Re-check against DB so access changes apply immediately.
  try {
    await connectDB();
    const freshUser = await User.findById(user.userId)
      .select('role allowedPages allowedActions')
      .lean();

    if (!freshUser) {
      return { error: forbiddenResponse() };
    }

    if (freshUser.role === 'super_admin') {
      return {
        user: {
          ...user,
          role: 'super_admin',
          allowedActions: normalizeAdminAllowedActions(
            freshUser.allowedActions,
          ),
        },
      };
    }

    if (
      freshUser.role === 'admin' &&
      hasAdminAction(action, freshUser.allowedActions, freshUser.allowedPages)
    ) {
      return {
        user: {
          ...user,
          role: 'admin',
          allowedPages: normalizeAdminAllowedPages(freshUser.allowedPages),
          allowedActions: normalizeAdminAllowedActions(
            freshUser.allowedActions,
          ),
        },
      };
    }
  } catch (error) {
    console.error('Error validating admin action access:', error);
  }

  return { error: forbiddenResponse() };
}
