import { NextRequest } from 'next/server';
import {
  getSessionForApp,
  updateProfileForApp,
} from '@/lib/auth/app-route-auth';

export async function GET() {
  return getSessionForApp('admin_panel');
}

export async function PUT(request: NextRequest) {
  return updateProfileForApp(request, 'admin_panel');
}
