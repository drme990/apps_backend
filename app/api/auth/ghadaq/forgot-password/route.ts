import { NextRequest } from 'next/server';
import { forgotPasswordForApp } from '@/lib/auth/app-route-auth';

export async function POST(request: NextRequest) {
  return forgotPasswordForApp(request, 'ghadaq');
}
