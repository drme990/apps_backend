import { NextRequest } from 'next/server';
import { getSessionForApp } from '@/lib/auth/app-route-auth';

export async function GET(request: NextRequest) {
  return getSessionForApp('ghadaq', request);
}
