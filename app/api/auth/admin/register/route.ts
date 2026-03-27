import { NextRequest } from 'next/server';
import { registerForApp } from '@/lib/auth/app-route-auth';

export async function POST(request: NextRequest) {
  return registerForApp(request, 'admin_panel');
}
