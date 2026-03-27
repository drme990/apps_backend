import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Model } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  getUserModelByAppId,
  type IBaseAppUser,
  type IBaseAppUserMethods,
} from '@/lib/auth/app-users';
import { logActivity } from '@/lib/services/logger';

const bodySchema = z.object({
  isBanned: z.boolean(),
});

type AppCustomerModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appId: 'ghadaq' | 'manasik'; id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('users');
    if ('error' in auth) return auth.error;

    const parsedBody = bodySchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload' },
        { status: 400 },
      );
    }

    const { appId, id } = await params;

    if (appId !== 'ghadaq' && appId !== 'manasik') {
      return NextResponse.json(
        { success: false, error: 'Invalid app id' },
        { status: 400 },
      );
    }

    const customerModel = getUserModelByAppId(
      appId,
    ) as unknown as AppCustomerModel;
    const customer = await customerModel.findByIdAndUpdate(
      id,
      { isBanned: parsedBody.data.isBanned },
      { new: true },
    );

    if (!customer) {
      return NextResponse.json(
        { success: false, error: 'Customer not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'user',
      resourceId: String(customer._id),
      details: `${parsedBody.data.isBanned ? 'Banned' : 'Unbanned'} customer ${customer.email} (${appId})`,
    });

    return NextResponse.json({
      success: true,
      data: {
        _id: String(customer._id),
        isBanned: Boolean(customer.isBanned),
      },
    });
  } catch (error) {
    console.error('Error updating customer ban status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update customer' },
      { status: 500 },
    );
  }
}
