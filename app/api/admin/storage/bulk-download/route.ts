import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '@/lib/services/r2';
import JSZip from 'jszip';

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { keys, folderName } = body;

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No keys provided' },
        { status: 400 }
      );
    }

    const zip = new JSZip();
    const bucket = process.env.R2_BUCKET_NAME || 'media';

    // Fetch all files in parallel
    const results = await Promise.allSettled(
      keys.map(async (key: string) => {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3Client.send(command);

        if (!response.Body) throw new Error(`Empty body for key: ${key}`);

        const buffer = await streamToBuffer(response.Body as AsyncIterable<Uint8Array>);

        // Preserve relative path inside zip (strip leading folder prefix if all share one)
        const zipPath = key.split('/').pop() || key;
        return { zipPath, buffer };
      })
    );

    let addedCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        zip.file(result.value.zipPath, result.value.buffer);
        addedCount++;
      } else {
        console.error('Error fetching file for bulk download:', result.reason);
      }
    }

    if (addedCount === 0) {
      return NextResponse.json(
        { success: false, error: 'All files failed to download' },
        { status: 500 }
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
    const safeName = (folderName || 'download').replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${safeName}-${now}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuffer.byteLength),
      },
    });
  } catch (error) {
    console.error('Error creating bulk download:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create bulk download' },
      { status: 500 }
    );
  }
}
