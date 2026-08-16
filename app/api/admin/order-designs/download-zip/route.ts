import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { requireAdminPageAccess } from '@/lib/auth';

interface ZipItemInput {
  url: string;
  filename: string;
}

/**
 * POST /api/admin/order-designs/download-zip
 *
 * Bundles a set of admin-selected order designs into a single ZIP file
 * so the admin doesn't have to download them one by one.
 *
 * Body: { items: Array<{ url: string; filename: string }> }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const body = await request.json().catch(() => null);
    const items: ZipItemInput[] = Array.isArray(body?.items) ? body.items : [];

    if (items.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No designs selected' },
        { status: 400 },
      );
    }

    const zip = new JSZip();
    const usedNames = new Set<string>();

    const results = await Promise.allSettled(
      items.map(async (item) => {
        if (!item?.url) throw new Error('Missing url');
        const response = await fetch(item.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${item.url}: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), filename: item.filename || item.url.split('/').pop() || 'design.jpg' };
      }),
    );

    let addedCount = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        console.error('[order-designs download-zip] Failed to fetch design:', result.reason);
        continue;
      }
      const { filename } = result.value;
      const safeName = filename.replace(/[^a-zA-Z0-9-_.\u0600-\u06FF ]/g, '_');
      let finalName = safeName;
      let suffix = 1;
      while (usedNames.has(finalName)) {
        const dotIndex = safeName.lastIndexOf('.');
        finalName = dotIndex === -1
          ? `${safeName}-${suffix}`
          : `${safeName.slice(0, dotIndex)}-${suffix}${safeName.slice(dotIndex)}`;
        suffix++;
      }
      usedNames.add(finalName);
      zip.file(finalName, result.value.buffer);
      addedCount++;
    }

    if (addedCount === 0) {
      return NextResponse.json(
        { success: false, error: 'All designs failed to download' },
        { status: 500 },
      );
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const now = new Date()
      .toISOString()
      .replace('T', '_')
      .replace(/:/g, '-')
      .split('.')[0];
    const filename = `order-designs-${now}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuffer.byteLength),
      },
    });
  } catch (error) {
    console.error('[order-designs download-zip] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create zip file' },
      { status: 500 },
    );
  }
}
