import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';
import { validateReferralCode } from '@/lib/services/referral-validation';

const referralValidationSchema = z
  .object({
    ref: z.string().trim().min(1),
  })
  .strict();

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, referralValidationSchema);
    if (!parsed.success) return parsed.response;

    const result = await validateReferralCode(parsed.data.ref);

    // Return 200 regardless of validity — the response body contains
    // { valid: boolean }. Don't log "not found" as an error; it's a
    // normal flow for invalid referral codes.
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('Error validating referral code:', error);

    return NextResponse.json(
      { valid: false, message: 'Failed to validate referral code' },
      { status: 500 },
    );
  }
}
