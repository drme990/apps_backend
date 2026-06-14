import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '@/lib/services/r2';
import JSZip from 'jszip';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { keys } = body;

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No keys provided' },
        { status: 400 }
      );
    }

    const zip = new JSZip();

    // Download each file and add to zip
    for (const key of keys) {
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME || 'media',
          Key: key,
        });

        const response = await s3Client.send(command);
        
        if (response.Body) {
          const fileName = key.split('/').pop() || key;
          // Convert stream to buffer
          const chunks: Buffer[] = [];
          for await (const chunk of response.Body as any) {
            chunks.push(Buffer.from(chunk));
          }
          const buffer = Buffer.concat(chunks);
          zip.file(fileName, buffer);
        }
      } catch (error) {
        console.error(`Error downloading file ${key}:`, error);
        // Continue with other files even if one fails
      }
    }

    // Generate the zip file
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    // Return the zip file as response
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="download-${Date.now()}.zip"`,
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
