import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { isR2Url } from '@/lib/services/r2';
import { captureException } from '@/lib/services/error-monitor';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'suppliers']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const url = searchParams.get('url');
    const filename = searchParams.get('filename') || 'invoice';

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 },
      );
    }

    if (!isR2Url(url)) {
      return NextResponse.json(
        { success: false, error: 'Invalid invoice URL' },
        { status: 400 },
      );
    }

    const response = await fetch(url);
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: `Failed to fetch invoice: ${response.status}` },
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
      service: 'InvoiceDownloadRoute',
      operation: 'GET_Download',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to download invoice' },
      { status: 500 },
    );
  }
}
