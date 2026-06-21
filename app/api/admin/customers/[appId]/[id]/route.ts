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
import CustomerHistory from '@/lib/models/CustomerHistory';

const bodySchema = z.object({
  ref: z.string().trim().nullable().optional(),
  detectedCountry: z.string().trim().nullable().optional(),
});

function getDefaultRefForApp(appId: string): string {
  return appId === 'ghadaq' ? 'GHD-D' : 'MNK-D';
}

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

    const body = parsedBody.data;
    const hasRef = 'ref' in body;
    const hasCountry = 'detectedCountry' in body;

    if (!hasRef && !hasCountry) {
      return NextResponse.json(
        { success: false, error: 'No fields to update' },
        { status: 400 },
      );
    }

    const customerModel = getUserModelByAppId(
      appId,
    ) as unknown as AppCustomerModel;
    const customerBefore = await customerModel
      .findById(id)
      .select('name email ref detectedCountry');

    if (!customerBefore) {
      return NextResponse.json(
        { success: false, error: 'Customer not found' },
        { status: 404 },
      );
    }

    const update: Record<string, unknown> = {};
    const changedFields: Array<{
      type: 'ref' | 'country';
      previousValue: string | null;
      newValue: string | null;
    }> = [];

    if (hasRef) {
      const nextRef = body.ref || getDefaultRefForApp(appId);
      const previousRef = customerBefore.ref || null;
      if (previousRef !== nextRef) {
        update.ref = nextRef;
        changedFields.push({
          type: 'ref',
          previousValue: previousRef,
          newValue: nextRef,
        });
      }
    }

    if (hasCountry) {
      const nextCountry = body.detectedCountry || null;
      const previousCountry = customerBefore.detectedCountry || null;
      if (previousCountry !== nextCountry) {
        update.detectedCountry = nextCountry;
        changedFields.push({
          type: 'country',
          previousValue: previousCountry,
          newValue: nextCountry,
        });
      }
    }

    if (changedFields.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          _id: String(customerBefore._id),
          ref: customerBefore.ref || null,
          detectedCountry: customerBefore.detectedCountry || null,
          changed: false,
        },
      });
    }

    const customer = await customerModel.findByIdAndUpdate(
      id,
      update,
      { returnDocument: 'after' },
    );

    if (!customer) {
      return NextResponse.json(
        { success: false, error: 'Customer not found' },
        { status: 404 },
      );
    }

    for (const field of changedFields) {
      await CustomerHistory.create({
        customerId: String(customer._id),
        appId,
        customerName: customerBefore.name,
        customerEmail: customerBefore.email,
        type: field.type,
        previousValue: field.previousValue,
        newValue: field.newValue,
        changeSource: field.type === 'ref' ? 'single' : null,
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
    }

    const logDetails = changedFields
      .map(
        (f) =>
          `${f.type}: ${f.previousValue || 'null'} -> ${f.newValue || 'null'}`,
      )
      .join(', ');

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'user',
      resourceId: String(customer._id),
      details: `Updated customer ${customer.email} (${appId}) — ${logDetails}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        _id: String(customer._id),
        ref: customer.ref || null,
        detectedCountry: customer.detectedCountry || null,
        changed: true,
      },
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update customer' },
      { status: 500 },
    );
  }
}
