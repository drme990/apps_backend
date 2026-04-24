import { NextRequest } from 'next/server';

/**
 * Extract client IP address from request
 * Checks multiple headers in order: CF-Connecting-IP, X-Forwarded-For, X-Real-IP
 * Falls back to remote address if no headers present
 */
export function getClientIp(request: NextRequest): string {
  // Check Cloudflare header (most reliable if using Cloudflare)
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp;

  // Check X-Forwarded-For (can contain multiple IPs, take first)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  // Check X-Real-IP
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;

  return 'unknown';
}

/**
 * Validate IP address format (IPv4 or IPv6)
 */
export function isValidIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;

  // IPv4 regex
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6 regex (simplified)
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}
