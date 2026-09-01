import Referral, { type ReferralAppId } from '@/lib/models/Referral';

export type ReferralValidationResponse = {
  valid: boolean;
  message?: string;
};

export function normalizeReferralCode(raw: string | null | undefined): string {
  return raw?.trim() ?? '';
}

/**
 * Default referral codes per app. These are always valid without a DB
 * lookup — they are the fallback when no explicit ref is provided.
 */
const DEFAULT_REF_BY_APP: Record<ReferralAppId, string> = {
  manasik: 'MNK-D',
  ghadaq: 'GHD-D',
};

/**
 * Validate a referral code. When `appId` is provided, the code must
 * belong to that app — a Manasik code cannot be used on Ghadaq and
 * vice versa. Default refs (MNK-D / GHD-D) are only valid for their
 * respective app when `appId` is specified.
 */
export async function validateReferralCode(
  rawRef: string | null | undefined,
  appId?: ReferralAppId,
): Promise<ReferralValidationResponse> {
  const referralId = normalizeReferralCode(rawRef);

  if (!referralId) {
    return { valid: false, message: 'Referral code is required' };
  }

  // Default refs — only valid for their own app
  if (referralId === 'MNK-D' || referralId === 'GHD-D') {
    if (appId) {
      const expectedDefault = DEFAULT_REF_BY_APP[appId];
      if (referralId !== expectedDefault) {
        return {
          valid: false,
          message: `This referral code belongs to the other app`,
        };
      }
    }
    return { valid: true };
  }

  // Non-default refs — look up in DB and check appId if provided
  const query: Record<string, unknown> = { referralId };
  if (appId) query.appId = appId;

  const referral = await Referral.findOne(query)
    .select('_id referralId appId')
    .lean()
    .exec();

  if (!referral) {
    if (appId) {
      return {
        valid: false,
        message: 'Referral code not found for this app',
      };
    }
    return { valid: false, message: 'Referral code not found' };
  }

  return { valid: true };
}
