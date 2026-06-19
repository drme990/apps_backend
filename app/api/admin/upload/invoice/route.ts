import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { uploadFileToR2 } from '@/lib/services/r2';
import { captureException } from '@/lib/services/error-monitor';

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
];

const ALLOWED_FILE_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

function resolveInvoiceFolder(fileType: string): string {
  if (ALLOWED_IMAGE_TYPES.includes(fileType)) {
    return 'invoice/images';
  }
  return 'invoice/files';
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 },
      );
    }

    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid file type. Only images, PDF, DOC, DOCX, and TXT are allowed.',
        },
        { status: 400 },
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File size exceeds 10MB limit' },
        { status: 400 },
      );
    }

    const folder = resolveInvoiceFolder(file.type);
    const result = await uploadFileToR2(file, folder);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    captureException(error, {
      service: 'R2InvoiceRoute',
      operation: 'POST_Upload',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to upload invoice file' },
      { status: 500 },
    );
  }
}
