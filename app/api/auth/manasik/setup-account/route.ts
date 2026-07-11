import { NextRequest } from 'next/server';
import { setupAccountForApp } from '@/lib/auth/app-route-auth';

export async function POST(request: NextRequest) {
  return setupAccountForApp(request, 'manasik');
}
