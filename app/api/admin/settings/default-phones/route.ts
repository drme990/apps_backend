import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';
import {
  getDefaultPhones,
  setDefaultPhones,
  type DefaultPhonesValue,
} from '@/lib/models/Setting';

const defaultPhonesSchema = z
  .object({
    manasik: z.string().trim().min(3),
    ghadaq: z.string().trim().min(3),
  })
  .strict();

export async function GET() {
  try {
    await connectDB();

    // Allow access if user has either 'referrals' or 'customers' page access
    let auth = await requireAdminPageAccess('referrals');
    if ('error' in auth) {
      const customersAuth = await requireAdminPageAccess('customers');
      if ('error' in customersAuth) return auth.error;
      auth = customersAuth;
    }

    const phones = await getDefaultPhones();
    return NextResponse.json({ success: true, data: phones });
  } catch (error) {
    console.error('Error fetching default phones:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch default phones' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('referrals');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, defaultPhonesSchema);
    if (!parsed.success) return parsed.response;
    const phones: DefaultPhonesValue = parsed.data;

    await setDefaultPhones(phones);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'settings',
      resourceId: 'default-phones',
      details: `Updated default phone numbers — manasik: ${phones.manasik}, ghadaq: ${phones.ghadaq}`,
    });

    return NextResponse.json({ success: true, data: phones });
  } catch (error) {
    console.error('Error updating default phones:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update default phones' },
      { status: 500 },
    );
  }
}
