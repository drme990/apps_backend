import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { resolveIntent } from '@/lib/services/order-intent';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { bookingIntentResolveSchema } from '@/lib/validation/schemas';
import mongoose from 'mongoose';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid intent id' },
        { status: 400 },
      );
    }

    const parsed = await parseJsonBody(request, bookingIntentResolveSchema);
    if (!parsed.success) return parsed.response;
    const { outcome, note, cascade } = parsed.data;

    const result = await resolveIntent(
      {
        adminId: auth.user.userId,
        name: auth.user.name ?? auth.user.email,
        email: auth.user.email,
      },
      id,
      outcome,
      note,
      // Resolving one resolves the whole customer — the list shows one
      // row per customer, so the action must cover all their intents.
      cascade ?? true,
    );

    if (!result.ok) {
      const status =
        result.reason === 'not_found'
          ? 404
          : result.reason === 'not_owner'
            ? 403
            : 400;
      return NextResponse.json(
        { success: false, error: `Cannot resolve: ${result.reason}` },
        { status },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'bookingIntent',
      resourceId: id,
      details: `Resolved booking intent as ${outcome} (${result.resolvedCount} intents${cascade ? ', cascade' : ''})`,
    });

    return NextResponse.json({
      success: true,
      data: { resolvedCount: result.resolvedCount },
    });
  } catch (error) {
    console.error('Error resolving booking intent:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve booking intent' },
      { status: 500 },
    );
  }
}
