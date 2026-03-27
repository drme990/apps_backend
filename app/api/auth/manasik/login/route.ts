import { NextRequest } from 'next/server';
import { loginForApp } from '@/lib/auth/app-route-auth';

export async function POST(request: NextRequest) {
  return loginForApp(request, 'manasik');
}
