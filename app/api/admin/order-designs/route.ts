import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPageAccess } from '@/lib/auth';

/**
 * GET /api/admin/order-designs
 *
 * Proxies order-design listing requests from the admin panel to the
 * design app's `/api/projects?source=order` endpoint. The admin panel
 * calls this via its rewrite rule (`/api/:path*` → `/api/admin/:path*`).
 *
 * Authentication: the admin panel sends the user's JWT cookie, which
 * `requireAdminPageAccess` validates. The backend then forwards the
 * request to the design app using the shared callback secret
 * (`x-callback-secret` header) — no user JWT needed on the design app
 * side.
 *
 * Query params (all forwarded to the design app):
 *   - page, limit   — pagination
 *   - fromDate, toDate — date range filter (YYYY-MM-DD)
 *   - search        — substring match on project name
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const baseUrl = (process.env.DESIGN_APP_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      return NextResponse.json(
        { success: false, error: 'Design app URL not configured' },
        { status: 500 },
      );
    }

    const secret = process.env.DESIGN_APP_CALLBACK_SECRET;
    if (!secret) {
      return NextResponse.json(
        { success: false, error: 'Callback secret not configured' },
        { status: 500 },
      );
    }

    // Forward all query params to the design app
    const { searchParams } = request.nextUrl;
    const qs = new URLSearchParams();
    qs.set('source', 'order');
    // Forward pagination + filter params
    for (const key of ['page', 'limit', 'fromDate', 'toDate', 'search']) {
      const val = searchParams.get(key);
      if (val) qs.set(key, val);
    }

    const response = await fetch(
      `${baseUrl}/api/projects?${qs.toString()}`,
      {
        headers: { 'x-callback-secret': secret },
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[order-designs proxy] Design app returned', response.status, text);
      return NextResponse.json(
        { success: false, error: `Design app returned ${response.status}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[order-designs proxy] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch order designs' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/order-designs?id={projectId}
 *
 * Proxies design deletion from the admin panel to the design app.
 * Uses the callback secret for auth on the design app side.
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const baseUrl = (process.env.DESIGN_APP_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      return NextResponse.json(
        { success: false, error: 'Design app URL not configured' },
        { status: 500 },
      );
    }

    const secret = process.env.DESIGN_APP_CALLBACK_SECRET;
    if (!secret) {
      return NextResponse.json(
        { success: false, error: 'Callback secret not configured' },
        { status: 500 },
      );
    }

    const projectId = request.nextUrl.searchParams.get('id');
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Missing project id' },
        { status: 400 },
      );
    }

    const response = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'DELETE',
        headers: { 'x-callback-secret': secret },
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[order-designs proxy] Delete returned', response.status, text);
      return NextResponse.json(
        { success: false, error: `Design app returned ${response.status}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[order-designs proxy] Delete error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete order design' },
      { status: 500 },
    );
  }
}
