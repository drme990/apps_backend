import { getSessionForApp } from '@/lib/auth/app-route-auth';

export async function GET() {
  return getSessionForApp('ghadaq');
}
