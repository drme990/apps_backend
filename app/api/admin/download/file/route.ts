import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { isR2Url } from '@/lib/services/r2';
import { captureException } from '@/lib/services/error-monitor';

const ALLOWED_HOSTNAMES = new Set<string>([
  'storage.manasik.net',
]);

if (process.env.R2_PUBLIC_URL) {
  try {
    const { hostname } = new URL(process.env.R2_PUBLIC_URL);
    ALLOWED_HOSTNAMES.add(hostname);
  } catch {
    // Ignore malformed URLs and keep the app buildable.
  }
}

function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (ALLOWED_HOSTNAMES.has(parsed.hostname)) return true;
    return isR2Url(url);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'suppliers', 'execution']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const url = searchParams.get('url');
    const filename = searchParams.get('filename') || 'download';

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 },
      );
    }

    if (!isAllowedDownloadUrl(url)) {
      return NextResponse.json(
        { success: false, error: 'Invalid download URL' },
        { status: 400 },
      );
    }

    const response = await fetch(url);
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: `Failed to fetch file: ${response.status}` },
        { status: 502 },
      );
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const body = await response.arrayBuffer();

    const safeFilename = encodeURIComponent(filename).replace(/%20/g, ' ');
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
    if (contentLength) {
      headers.set('Content-Length', contentLength);
    }

    return new NextResponse(body, { headers });
  } catch (error) {
    captureException(error, {
      service: 'FileDownloadRoute',
      operation: 'GET_Download',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to download file' },
      { status: 500 },
    );
  }
}
