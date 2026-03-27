import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import PaymentLink from '@/lib/models/PaymentLink';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('payments');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Payment link id is required' },
        { status: 400 },
      );
    }

    const updated = await PaymentLink.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: {
            userId: auth.user.userId,
            userName: auth.user.name,
            userEmail: auth.user.email,
          },
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'Payment link not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { id: String(updated._id) },
    });
  } catch (error) {
    console.error('Error deleting payment link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete payment link' },
      { status: 500 },
    );
  }
}
