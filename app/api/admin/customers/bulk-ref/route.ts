import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  getUserModelByAppId,
  type IBaseAppUser,
  type IBaseAppUserMethods,
} from '@/lib/auth/app-users';
import CustomerRefHistory from '@/lib/models/CustomerRefHistory';
import type { Model } from 'mongoose';

const bodySchema = z.object({
  ref: z.string().trim().nullable(),
  customers: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        appId: z.enum(['ghadaq', 'manasik']),
      }),
    )
    .min(1),
});

type AppCustomerModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

function getDefaultRefForApp(appId: 'ghadaq' | 'manasik'): string {
  return appId === 'ghadaq' ? 'default-GHD' : 'default-MNK';
}

export async function PATCH(request: NextRequest) {
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

    const requestedRef = parsedBody.data.ref || null;

    const results = await Promise.all(
      parsedBody.data.customers.map(async ({ id, appId }) => {
        const customerModel = getUserModelByAppId(
          appId,
        ) as unknown as AppCustomerModel;

        const customerBefore = await customerModel
          .findById(id)
          .select('name email ref');

        if (!customerBefore) {
          return { id, appId, updated: false, reason: 'not_found' as const };
        }

        const previousRef = customerBefore.ref || null;
        const nextRef = requestedRef || getDefaultRefForApp(appId);
        if (previousRef === nextRef) {
          return { id, appId, updated: false, reason: 'unchanged' as const };
        }

        const customer = await customerModel.findByIdAndUpdate(
          id,
          { ref: nextRef },
          { returnDocument: 'after' },
        );

        if (!customer) {
          return { id, appId, updated: false, reason: 'not_found' as const };
        }

        await CustomerRefHistory.create({
          customerId: String(customer._id),
          appId,
          customerName: customerBefore.name,
          customerEmail: customerBefore.email,
          previousRef,
          newRef: nextRef,
          changedByUserId: auth.user.userId,
          changedByUserName: auth.user.name,
          changedByUserEmail: auth.user.email,
          changeSource: 'bulk',
        });

        return { id, appId, updated: true };
      }),
    );

    return NextResponse.json({
      success: true,
      data: {
        ref: requestedRef,
        results,
      },
    });
  } catch (error) {
    console.error('Error bulk updating customer refs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update customer refs' },
      { status: 500 },
    );
  }
}
