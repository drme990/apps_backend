import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getUserModelByAppId } from '@/lib/auth/app-users';

type AppProfileRecord = {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  country?: string;
  isBanned?: boolean;
};

type AppProfileModel = mongoose.Model<AppProfileRecord>;

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phone: z.string().trim().optional(),
    country: z.string().trim().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

async function resolveAppUser() {
  const ghadq = await getAuthUser('ghadaq');
  if (ghadq) return ghadq;

  const manasik = await getAuthUser('manasik');
  if (manasik) return manasik;

  const admin = await getAuthUser('admin_panel');
  if (admin) return admin;

  return null;
}

export async function GET() {
  try {
    await connectDB();

    const user = await resolveAppUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const UserModel = getUserModelByAppId(
      user.appId,
    ) as unknown as AppProfileModel;
    const fullUser = await UserModel.findById(user.userId);

    if (!fullUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    if (user.appId !== 'admin_panel' && fullUser.isBanned) {
      return NextResponse.json(
        { success: false, error: 'Your account has been banned' },
        { status: 403 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        _id: fullUser._id,
        name: fullUser.name,
        email: fullUser.email,
        appId: user.appId,
        phone: (fullUser as { phone?: string }).phone || '',
        country: (fullUser as { country?: string }).country || '',
      },
    });
  } catch (error) {
    console.error('Error fetching auth user profile:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch profile' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await connectDB();

    const user = await resolveAppUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message || 'Invalid payload',
        },
        { status: 400 },
      );
    }

    const UserModel = getUserModelByAppId(
      user.appId,
    ) as unknown as AppProfileModel;
    const updatePayload: Record<string, string> = {};

    if (typeof parsed.data.name === 'string') {
      updatePayload.name = parsed.data.name;
    }

    if (typeof parsed.data.phone === 'string') {
      updatePayload.phone = parsed.data.phone;
    }

    if (typeof parsed.data.country === 'string') {
      updatePayload.country = parsed.data.country;
    }

    const updatedUser = await UserModel.findByIdAndUpdate(
      user.userId,
      updatePayload,
      {
        new: true,
        runValidators: true,
      },
    );

    if (!updatedUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        appId: user.appId,
        phone: (updatedUser as { phone?: string }).phone || '',
        country: (updatedUser as { country?: string }).country || '',
      },
    });
  } catch (error) {
    console.error('Error updating auth user profile:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update profile' },
      { status: 500 },
    );
  }
}
