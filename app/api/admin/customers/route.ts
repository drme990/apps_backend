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

const querySchema = z.object({
  appId: z.enum(['ghadaq', 'manasik']).optional(),
  search: z.string().trim().optional(),
  isBanned: z.enum(['true', 'false']).optional(),
});

type CustomerDTO = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  appId: 'ghadaq' | 'manasik';
  isBanned: boolean;
  createdAt: Date;
};

type AppCustomerModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('users');
    if ('error' in auth) return auth.error;

    const parsed = querySchema.safeParse({
      appId: request.nextUrl.searchParams.get('appId') || undefined,
      search: request.nextUrl.searchParams.get('search') || undefined,
      isBanned: request.nextUrl.searchParams.get('isBanned') || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters' },
        { status: 400 },
      );
    }

    const normalizedSearch = parsed.data.search?.toLowerCase();
    const isBannedFilter =
      parsed.data.isBanned === undefined
        ? undefined
        : parsed.data.isBanned === 'true';

    const appIds: Array<'ghadaq' | 'manasik'> = parsed.data.appId
      ? [parsed.data.appId]
      : ['ghadaq', 'manasik'];

    const results = await Promise.all(
      appIds.map(async (appId) => {
        const model = getUserModelByAppId(appId) as unknown as AppCustomerModel;
        const customers = await model
          .find()
          .sort({ createdAt: -1 })
          .select('name email phone country isBanned createdAt')
          .lean();

        return customers.map(
          (customer): CustomerDTO => ({
            _id: String(customer._id),
            name: typeof customer.name === 'string' ? customer.name : '',
            email: typeof customer.email === 'string' ? customer.email : '',
            phone: typeof customer.phone === 'string' ? customer.phone : '',
            country:
              typeof customer.country === 'string' ? customer.country : '',
            appId,
            isBanned: Boolean(customer.isBanned),
            createdAt:
              customer.createdAt instanceof Date
                ? customer.createdAt
                : new Date(0),
          }),
        );
      }),
    );

    let customers: CustomerDTO[] = results.flat();

    if (normalizedSearch) {
      customers = customers.filter(
        (customer) =>
          customer.name.toLowerCase().includes(normalizedSearch) ||
          customer.email.toLowerCase().includes(normalizedSearch) ||
          customer.phone.toLowerCase().includes(normalizedSearch),
      );
    }

    if (typeof isBannedFilter === 'boolean') {
      customers = customers.filter(
        (customer) => customer.isBanned === isBannedFilter,
      );
    }

    customers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return NextResponse.json({
      success: true,
      data: { customers },
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch customers' },
      { status: 500 },
    );
  }
}
