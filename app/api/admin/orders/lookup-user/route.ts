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

// Build a regex from all 3-digit substrings of the provided digits.
// Used to find candidate users for fuzzy matching.
function buildCandidateRegex(digits: string): string | null {
  if (digits.length < 3) return null;
  const substrings = new Set<string>();
  for (let i = 0; i <= digits.length - 3; i++) {
    substrings.add(digits.substring(i, i + 3));
  }
  if (substrings.size === 0) return null;
  return Array.from(substrings).map(escapeRegex).join('|');
}

// Longest Common Subsequence length between two strings.
function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;

  // Use two rows to keep memory usage low.
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
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
    const auth = await requireAdminPageAccess(['orders', 'execution']);
    if ('error' in auth) return auth.error;

    const phone = request.nextUrl.searchParams.get('phone')?.trim();
    const email = request.nextUrl.searchParams.get('email')?.trim();

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

      const phoneConditions = [
        { phone: { $regex: escapedPhone, $options: 'i' } },
        { phone: { $regex: escapedNormalized, $options: 'i' } },
      ] as Array<Record<string, unknown>>;
      if (!normalizedPhone.startsWith('+')) {
        phoneConditions.push({
          phone: { $regex: `\\+${escapedNormalized}`, $options: 'i' },
        });
      }
      if (flexibleRegex) {
        phoneConditions.push({ phone: { $regex: flexibleRegex, $options: 'i' } });
      }

      conditions.push(...phoneConditions);
    }

    if (email) {
      const escapedEmail = escapeRegex(email);
      const emailDigitsRegex = phoneNumberRegex(email);

      conditions.push(
        { email: { $regex: escapedEmail, $options: 'i' } },
      );
      if (emailDigitsRegex) {
        conditions.push({ email: { $regex: emailDigitsRegex, $options: 'i' } });
      }
    }

    // Search both apps for users with matching phone or email
    const apps: Array<'manasik' | 'ghadaq'> = ['manasik', 'ghadaq'];
    const users: LookupUser[] = [];
    const seenIds = new Set<string>();

    // Fuzzy search is scoped to the same field the admin typed in:
    // phone input -> phone field only, email input -> email field only.
    const fuzzyField = phone ? 'phone' : email ? 'email' : null;
    const fuzzyDigits = phone ? extractDigits(phone) : email ? extractDigits(email) : '';
    const candidateRegex =
      fuzzyField && fuzzyDigits.length >= 3 ? buildCandidateRegex(fuzzyDigits) : null;

    for (const appId of apps) {
      if (users.length >= 10) break;

      const Model = getUserModelByAppId(appId) as unknown as LookupUserModel;

      // 1. Exact / substring matches
      const exactUsers = await Model.find({ $or: conditions })
        .select('_id name email phone country appId')
        .limit(10)
        .lean();

      if (exactUsers.length > 0) {
        exactUsers.forEach((user) => {
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
          }
        });
        continue;
      }

      // 2. Fuzzy fallback: find candidates that share any 3-digit substring,
      // then keep those whose digit LCS is at least 75% of the search length.
      if (fuzzyField && candidateRegex && fuzzyDigits.length > 3) {
        const threshold = Math.ceil(fuzzyDigits.length * 0.75);
        const candidateQuery =
          fuzzyField === 'phone'
            ? { phone: { $regex: candidateRegex, $options: 'i' } }
            : { email: { $regex: candidateRegex, $options: 'i' } };
        const candidates = await Model.find(candidateQuery)
          .select('_id name email phone country appId')
          .limit(100)
          .lean();

        for (const user of candidates) {
          const candidateValue = fuzzyField === 'phone' ? user.phone || '' : user.email || '';
          const candidateDigits = extractDigits(candidateValue);
          if (lcsLength(fuzzyDigits, candidateDigits) >= threshold) {
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
            }
            if (users.length >= 10) break;
          }
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
