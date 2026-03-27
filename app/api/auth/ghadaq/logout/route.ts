import { logoutForApp } from '@/lib/auth/app-route-auth';

export async function POST() {
  return logoutForApp('ghadaq');
}
