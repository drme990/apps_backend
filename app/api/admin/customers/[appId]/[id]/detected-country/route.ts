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
import CustomerCountryHistory from '@/lib/models/CustomerCountryHistory';

const bodySchema = z.object({
  detectedCountry: z.string().trim().nullable(),
});

type AppCustomerModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string; id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('customers');
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
    const customerBefore = await customerModel
      .findById(id)
      .select('name email detectedCountry');

    if (!customerBefore) {
      return NextResponse.json(
        { success: false, error: 'Customer not found' },
        { status: 404 },
      );
    }

    const nextCountry = parsedBody.data.detectedCountry || null;
    const previousCountry = customerBefore.detectedCountry || null;

    if (previousCountry === nextCountry) {
      return NextResponse.json({
        success: true,
        data: {
          _id: String(customerBefore._id),
          detectedCountry: previousCountry,
          changed: false,
        },
      });
    }

    const customer = await customerModel.findByIdAndUpdate(
      id,
      { detectedCountry: nextCountry },
      { returnDocument: 'after' },
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
      details: `Updated detectedCountry for customer ${customer.email} (${appId}) from: ${previousCountry || 'null'} to: ${nextCountry || 'null'}`,
    });

    await CustomerCountryHistory.create({
      customerId: String(customer._id),
      appId,
      customerName: customerBefore.name,
      customerEmail: customerBefore.email,
      previousCountry,
      newCountry: nextCountry,
      changedByUserId: auth.user.userId,
      changedByUserName: auth.user.name,
      changedByUserEmail: auth.user.email,
    });

    return NextResponse.json({
      success: true,
      data: {
        _id: String(customer._id),
        detectedCountry: customer.detectedCountry || null,
        changed: true,
      },
    });
  } catch (error) {
    console.error('Error updating customer detectedCountry:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update customer' },
      { status: 500 },
    );
  }
}
