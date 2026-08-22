import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  uploadFileToR2,
  deleteFileFromR2,
  isR2Url,
  extractR2Key,
} from '@/lib/services/r2';
import { captureException } from '@/lib/services/error-monitor';
import { z } from 'zod';

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
    const auth = await requireAdminPageAccess(['suppliers', 'execution', 'orders']);
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const file = formData.get('file');
    const oldUrl = formData.get('oldUrl');

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

    // Delete the old invoice file after the new upload succeeds, to
    // prevent orphaned files from accumulating in R2. The old URL must
    // be an R2 URL and must not be the same as the newly uploaded key.
    if (typeof oldUrl === 'string' && oldUrl && isR2Url(oldUrl)) {
      const oldKey = extractR2Key(oldUrl);
      if (oldKey && oldKey !== result.key) {
        try {
          await deleteFileFromR2(oldKey);
        } catch (deleteError) {
          // Log but don't fail the upload — the new file is already stored.
          console.error('[POST /api/admin/upload/invoice] Failed to delete old invoice:', deleteError);
        }
      }
    }

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

const deleteInvoiceSchema = z.object({
  url: z.string().url(),
});

/**
 * DELETE /api/admin/upload/invoice
 *
 * Deletes an invoice file from R2 by its public URL. Uses the same
 * auth scope as the POST route (suppliers, execution, orders) so that
 * admins who can upload invoices can also delete them — the image
 * DELETE route requires 'appearance' access which invoice managers
 * may not have.
 */
export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['suppliers', 'execution', 'orders']);
    if ('error' in auth) return auth.error;

    const body = await request.json().catch(() => null);
    const parsed = deleteInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing url' },
        { status: 400 },
      );
    }

    const { url } = parsed.data;

    if (!isR2Url(url)) {
      return NextResponse.json(
        { success: false, error: 'Not a valid R2 URL' },
        { status: 400 },
      );
    }

    const key = extractR2Key(url);
    if (!key) {
      return NextResponse.json(
        { success: false, error: 'Could not extract object key from URL' },
        { status: 400 },
      );
    }

    await deleteFileFromR2(key);

    return NextResponse.json({
      success: true,
      message: 'Invoice file deleted successfully',
    });
  } catch (error) {
    captureException(error, {
      service: 'R2InvoiceRoute',
      operation: 'DELETE_Invoice',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to delete invoice file' },
      { status: 500 },
    );
  }
}
