import { NextRequest } from 'next/server';
import { resetPasswordForApp } from '@/lib/auth/app-route-auth';

export async function POST(request: NextRequest) {
  return resetPasswordForApp(request, 'ghadaq');
}
