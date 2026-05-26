import { NextRequest } from 'next/server';
import {
  getProfileForApp,
  updateProfileForApp,
} from '@/lib/auth/app-route-auth';

export async function GET(request: NextRequest) {
  return getProfileForApp('manasik', request);
}

export async function PUT(request: NextRequest) {
  return updateProfileForApp(request, 'manasik');
}
