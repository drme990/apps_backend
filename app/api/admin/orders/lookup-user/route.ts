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

function extractDigits(value: string): string {
  return value.replace(/\D/g, '');
}

// Build a regex that matches the digits in order while ignoring any
// formatting characters (spaces, dots, parentheses, dashes) between them.
// This lets a search like "01018" match a DB value like "+20 101 832 6780".
function phoneNumberRegex(value: string): string {
  const digits = extractDigits(value).split('');
  if (digits.length === 0) return '';
  return digits.map((digit) => escapeRegex(digit)).join('[^0-9]*');
}

type LookupUserModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

type LookupUser = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  appId: string;
};

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders']);
    if ('error' in auth) return auth.error;

    const phone = request.nextUrl.searchParams.get('phone')?.trim();
    const email = request.nextUrl.searchParams.get('email')?.trim();
    const source = request.nextUrl.searchParams.get('source')?.trim();

    if (!phone && !email) {
      return NextResponse.json(
        { success: false, error: 'Phone number or email is required' },
        { status: 400 },
      );
    }

    const conditions: Array<Record<string, unknown>> = [];

    if (phone) {
      const searchPhone = phone;
      const escapedPhone = escapeRegex(searchPhone);
      const normalizedPhone = searchPhone.replace(/[\s().-]/g, '');
      const escapedNormalized = escapeRegex(normalizedPhone);
      const flexibleRegex = phoneNumberRegex(phone);

      // Prefix matching — the DB value must START WITH the search input.
      // This prevents unrelated results that merely contain the digits
      // somewhere in the middle.
      const phoneConditions = [
        { phone: { $regex: `^${escapedPhone}`, $options: 'i' } },
        { phone: { $regex: `^${escapedNormalized}`, $options: 'i' } },
      ] as Array<Record<string, unknown>>;
      // Also match if the DB phone starts with + followed by the normalized
      // digits (e.g. search "201018" matches "+201018326780")
      if (!normalizedPhone.startsWith('+')) {
        phoneConditions.push({
          phone: { $regex: `^\\+${escapedNormalized}`, $options: 'i' },
        });
      }
      // Flexible regex also anchored to the start — digits must appear
      // from the beginning, ignoring formatting characters
      if (flexibleRegex) {
        phoneConditions.push({ phone: { $regex: `^${flexibleRegex}`, $options: 'i' } });
      }

      conditions.push(...phoneConditions);
    }

    if (email) {
      const escapedEmail = escapeRegex(email);

      // Prefix matching — email must START WITH the search input
      conditions.push(
        { email: { $regex: `^${escapedEmail}`, $options: 'i' } },
      );
    }

    // Search the requested app, or both if no source is provided
    const allApps: Array<'manasik' | 'ghadaq'> = ['manasik', 'ghadaq'];
    const apps: Array<'manasik' | 'ghadaq'> =
      source === 'manasik' || source === 'ghadaq' ? [source] : allApps;
    const users: LookupUser[] = [];
    const seenIds = new Set<string>();

    for (const appId of apps) {
      if (users.length >= 10) break;

      const Model = getUserModelByAppId(appId) as unknown as LookupUserModel;

      // Prefix matches only — no fuzzy fallback. The DB value must
      // start with the search input.
      const matchedUsers = await Model.find({ $or: conditions })
        .select('_id name email phone country appId')
        .limit(10)
        .lean();

      for (const user of matchedUsers) {
        const id = String(user._id);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          users.push({
            _id: id,
            name: user.name || '',
            email: user.email || '',
            phone: user.phone || '',
            country: user.country || '',
            appId: user.appId,
          });
          if (users.length >= 10) break;
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: users,
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
