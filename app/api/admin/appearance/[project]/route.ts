import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Appearance from '@/lib/models/Appearance';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { appearanceUpdateSchema } from '@/lib/validation/schemas';
import { AudioReviewInput, validateAudioMains } from '@/lib/audio-main-logic';
import { cleanupRemovedAppearanceMedia } from '@/lib/services/media-cleanup';

/** Every field on an appearance doc that can hold an R2 URL. */
function collectAppearanceUrls(doc: {
  worksImages?: { row1?: string[]; row2?: string[] };
  productsBanners?: Array<{ imageUrl?: string }>;
  audioReviews?: Array<{ url?: string; userImage?: string }>;
}): string[] {
  const urls: string[] = [];
  urls.push(...(doc.worksImages?.row1 ?? []));
  urls.push(...(doc.worksImages?.row2 ?? []));
  for (const b of doc.productsBanners ?? []) {
    if (b.imageUrl) urls.push(b.imageUrl);
  }
  for (const a of doc.audioReviews ?? []) {
    if (a.url) urls.push(a.url);
    if (a.userImage) urls.push(a.userImage);
  }
  return urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
}

const VALID_PROJECTS = ['ghadaq', 'manasik', 'shared'];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ project: string }> },
) {
  try {
    await connectDB();

    const { project } = await params;
    if (!VALID_PROJECTS.includes(project)) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Invalid project. Must be one of: ' + VALID_PROJECTS.join(', '),
        },
        { status: 400 },
      );
    }

    const appearance = await Appearance.findOne({ project }).lean();

    // Validate audio mains on load to fix any data inconsistencies
    if (appearance?.audioReviews && Array.isArray(appearance.audioReviews)) {
      appearance.audioReviews = validateAudioMains(
        appearance.audioReviews as AudioReviewInput[],
      );
    }

    return NextResponse.json({ success: true, data: appearance });
  } catch (error) {
    console.error('Error fetching appearance:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch appearance' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const { project } = await params;
    if (!VALID_PROJECTS.includes(project)) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Invalid project. Must be one of: ' + VALID_PROJECTS.join(', '),
        },
        { status: 400 },
      );
    }

    const parsed = await parseJsonBody(request, appearanceUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    // Validate audio reviews - enforce main audio rules
    if (body.audioReviews && Array.isArray(body.audioReviews)) {
      body.audioReviews = validateAudioMains(body.audioReviews);
    }

    // Snapshot the previous doc's URLs so removed files can be cleaned
    // from R2 after a successful save — never before (a cancelled or
    // failed save must not leave broken references on the live site).
    const previousUrls = collectAppearanceUrls(
      (await Appearance.findOne({ project }).lean()) ?? {},
    );

    const appearance = await Appearance.findOneAndUpdate(
      { project },
      { ...body, project },
      {
        returnDocument: 'after',
        upsert: true,
        runValidators: true,
      },
    );

    if (previousUrls.length > 0) {
      const keptUrls = new Set(collectAppearanceUrls(appearance.toObject()));
      const removedUrls = previousUrls.filter((u) => !keptUrls.has(u));
      if (removedUrls.length > 0) {
        await cleanupRemovedAppearanceMedia(removedUrls, project).catch((err) =>
          console.error('[PUT /api/admin/appearance] media cleanup failed:', err),
        );
      }
    }
    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'appearance',
      resourceId: appearance._id.toString(),
      details: `Updated appearance for project: ${project}`,
    });

    return NextResponse.json({ success: true, data: appearance });
  } catch (error) {
    console.error('Error updating appearance:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update appearance' },
      { status: 500 },
    );
  }
}
