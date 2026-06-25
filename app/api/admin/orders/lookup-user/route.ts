import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  getUserModelByAppId,
  type IBaseAppUser,
  type IBaseAppUserMethods,
} from '@/lib/auth/app-users';
import type { Model } from 'mongoose';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type LookupUserModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'execution']);
    if ('error' in auth) return auth.error;

    const phone = request.nextUrl.searchParams.get('phone')?.trim();
    if (!phone) {
      return NextResponse.json(
        { success: false, error: 'Phone number is required' },
        { status: 400 },
      );
    }

    const searchPhone = phone;
    const escapedPhone = escapeRegex(searchPhone);
    const normalizedPhone = searchPhone.replace(/[\s().-]/g, '');
    const escapedNormalized = escapeRegex(normalizedPhone);

    const conditions: Array<Record<string, unknown>> = [
      { phone: { $regex: escapedPhone, $options: 'i' } },
      { phone: { $regex: escapedNormalized, $options: 'i' } },
    ];
    if (!normalizedPhone.startsWith('+')) {
      conditions.push({
        phone: { $regex: `\\+${escapedNormalized}`, $options: 'i' },
      });
    }

    // Search both apps for a user with matching phone
    const apps: Array<'manasik' | 'ghadaq'> = ['manasik', 'ghadaq'];
    for (const appId of apps) {
      const Model = getUserModelByAppId(appId) as unknown as LookupUserModel;
      const user = await Model.findOne({ $or: conditions })
        .select('_id name email phone country appId')
        .lean();

      if (user) {
        return NextResponse.json({
          success: true,
          data: {
            _id: String(user._id),
            name: user.name || '',
            email: user.email || '',
            phone: user.phone || '',
            country: user.country || '',
            appId: user.appId,
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: null,
    });
  } catch (error) {
    console.error('Lookup user error:', error);
    const message = error instanceof Error ? error.message : 'Failed to lookup user';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
