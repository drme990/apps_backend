import { NextRequest } from 'next/server';
import {
  getProfileForApp,
  updateProfileForApp,
} from '@/lib/auth/app-route-auth';

export async function GET() {
  return getProfileForApp('ghadaq');
}

export async function PUT(request: NextRequest) {
  return updateProfileForApp(request, 'ghadaq');
}
