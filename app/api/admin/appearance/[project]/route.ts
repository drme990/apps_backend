import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Appearance from '@/lib/models/Appearance';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { appearanceUpdateSchema } from '@/lib/validation/schemas';

const VALID_PROJECTS = ['ghadaq', 'manasik'];

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
    const auth = await requireAuth();
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
    const appearance = await Appearance.findOneAndUpdate(
      { project },
      { ...body, project },
      { new: true, upsert: true, runValidators: true },
    );

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
