import Referral from '@/lib/models/Referral';

export type ReferralValidationResponse = {
  valid: boolean;
  message?: string;
};

export function normalizeReferralCode(raw: string | null | undefined): string {
  return raw?.trim() ?? '';
}

export async function validateReferralCode(
  rawRef: string | null | undefined,
): Promise<ReferralValidationResponse> {
  const referralId = normalizeReferralCode(rawRef);

  if (!referralId) {
    return { valid: false, message: 'Referral code is required' };
  }

  const referral = await Referral.findOne({ referralId })
    .select('_id referralId')
    .lean()
    .exec();

  if (!referral) {
    return { valid: false, message: 'Referral code not found' };
  }

  return { valid: true };
}
