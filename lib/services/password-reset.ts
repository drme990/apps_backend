import { randomBytes, createHash } from 'node:crypto';
import { Resend } from 'resend';
import PasswordResetToken from '@/lib/models/PasswordResetToken';
import PasswordResetThrottle from '@/lib/models/PasswordResetThrottle';

export type PasswordResetApp = 'ghadaq' | 'manasik';

type ThrottleResult =
  | { allowed: true; attempt: number; nextRetrySeconds: number }
  | {
      allowed: false;
      reason: 'cooldown' | 'banned';
      retryAfterSeconds: number;
      message: string;
    };

const TOKEN_TTL_MINUTES = 30;
const ONE_DAY_SECONDS = 24 * 60 * 60;

const APP_CONFIG = {
  ghadaq: {
    apiKey: process.env.GHADAQ_RESEND_API_KEY,
    from: process.env.GHADAQ_FROM_EMAIL || 'orders@ghadaqplus.com',
    support:
      process.env.GHADAQ_SUPPORT_EMAIL ||
      process.env.GHADAQ_FROM_EMAIL ||
      'support@ghadaqplus.com',
    baseUrl: process.env.GHADAQ_URL || 'http://localhost:3002',
    brandName: 'Ghadaq Association',
  },
  manasik: {
    apiKey: process.env.MANASIK_RESEND_API_KEY,
    from: process.env.MANASIK_FROM_EMAIL || 'orders@manasik.net',
    support:
      process.env.MANSIK_SUPPORT_EMAIL ||
      process.env.MANASIK_SUPPORT_EMAIL ||
      process.env.MANASIK_FROM_EMAIL ||
      'support@manasik.net',
    baseUrl: process.env.MANASIK_URL || 'http://localhost:3001',
    brandName: 'Manasik Foundation',
  },
} as const;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function secondsUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

export async function consumeResetThrottle(
  app: PasswordResetApp,
  email: string,
): Promise<ThrottleResult> {
  const identifier = `password-reset:${app}:${email.toLowerCase()}`;
  const now = new Date();

  let doc = await PasswordResetThrottle.findOne({ identifier });
  if (!doc) {
    doc = await PasswordResetThrottle.create({
      identifier,
      attempts: 0,
    });
  }

  // Ban window ended, user can retry from zero.
  if (doc.bannedUntil && doc.bannedUntil.getTime() <= now.getTime()) {
    doc.attempts = 0;
    doc.bannedUntil = undefined;
    doc.nextAllowedAt = undefined;
  }

  if (doc.bannedUntil && doc.bannedUntil.getTime() > now.getTime()) {
    const retryAfterSeconds = secondsUntil(doc.bannedUntil);
    await doc.save();
    return {
      allowed: false,
      reason: 'banned',
      retryAfterSeconds,
      message: 'try again latter',
    };
  }

  if (doc.nextAllowedAt && doc.nextAllowedAt.getTime() > now.getTime()) {
    const retryAfterSeconds = secondsUntil(doc.nextAllowedAt);
    await doc.save();
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfterSeconds,
      message: `Please wait ${retryAfterSeconds}s before requesting again`,
    };
  }

  if (doc.attempts >= 3) {
    doc.bannedUntil = new Date(now.getTime() + ONE_DAY_SECONDS * 1000);
    doc.nextAllowedAt = undefined;
    await doc.save();
    return {
      allowed: false,
      reason: 'banned',
      retryAfterSeconds: ONE_DAY_SECONDS,
      message: 'try again latter',
    };
  }

  const nextAttempt = doc.attempts + 1;
  doc.attempts = nextAttempt;

  // 1st send immediately, 2nd requires 60s gap, 3rd requires 120s gap.
  // After the 3rd successful send, user is banned for one day.
  let nextRetrySeconds = 0;
  if (nextAttempt === 1) {
    nextRetrySeconds = 60;
    doc.nextAllowedAt = new Date(now.getTime() + nextRetrySeconds * 1000);
  } else if (nextAttempt === 2) {
    nextRetrySeconds = 120;
    doc.nextAllowedAt = new Date(now.getTime() + nextRetrySeconds * 1000);
  } else {
    nextRetrySeconds = ONE_DAY_SECONDS;
    doc.nextAllowedAt = undefined;
    doc.bannedUntil = new Date(now.getTime() + ONE_DAY_SECONDS * 1000);
  }

  await doc.save();

  return { allowed: true, attempt: nextAttempt, nextRetrySeconds };
}

export async function createPasswordResetToken(
  app: PasswordResetApp,
  email: string,
): Promise<string> {
  const normalizedEmail = email.toLowerCase().trim();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  await PasswordResetToken.deleteMany({
    appId: app,
    email: normalizedEmail,
    usedAt: null,
  });

  await PasswordResetToken.create({
    appId: app,
    email: normalizedEmail,
    tokenHash,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000),
  });

  return token;
}

export async function verifyPasswordResetToken(
  app: PasswordResetApp,
  email: string,
  token: string,
) {
  const tokenHash = hashToken(token);
  return PasswordResetToken.findOne({
    appId: app,
    email: email.toLowerCase().trim(),
    tokenHash,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });
}

export async function markPasswordResetTokenUsed(tokenId: string) {
  await PasswordResetToken.findByIdAndUpdate(tokenId, {
    $set: { usedAt: new Date() },
  });
}

export async function sendPasswordResetEmail(
  app: PasswordResetApp,
  userEmail: string,
  token: string,
) {
  const cfg = APP_CONFIG[app];
  if (!cfg.apiKey) {
    console.log(
      `[PasswordReset] Missing resend API key for ${app} - skipping email send`,
    );
    return;
  }

  const resend = new Resend(cfg.apiKey);
  const resetUrl = `${cfg.baseUrl}/auth/reset-password?email=${encodeURIComponent(userEmail)}&token=${encodeURIComponent(token)}`;

  const text = [
    `We received a password reset request for your ${cfg.brandName} account.`,
    `Reset link (valid for ${TOKEN_TTL_MINUTES} minutes): ${resetUrl}`,
    `If you did not request this, ignore this email or contact support: ${cfg.support}`,
  ].join('\n\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
      <h2 style="margin:0 0 12px;">Reset your password</h2>
      <p>We received a password reset request for your <strong>${cfg.brandName}</strong> account.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;">
          Reset Password
        </a>
      </p>
      <p>This link is valid for ${TOKEN_TTL_MINUTES} minutes.</p>
      <p>If you did not request this, you can safely ignore this email.</p>
      <p>Support: <a href="mailto:${cfg.support}">${cfg.support}</a></p>
    </div>
  `;

  await resend.emails.send({
    from: `${cfg.brandName} <${cfg.from}>`,
    to: [userEmail],
    subject: 'Reset your password',
    text,
    html,
    replyTo: cfg.support,
  });
}
