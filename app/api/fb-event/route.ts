import { NextRequest, NextResponse } from 'next/server';
import { sendFBEvent } from '@/lib/services/fb-capi';
import { parseJsonBody } from '@/lib/validation/http';
import { fbEventSchema } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, fbEventSchema);
    if (!parsed.success) return parsed.response;
    const { event_name, event_id, event_source_url, user_data, custom_data } =
      parsed.data;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const userAgent = request.headers.get('user-agent') || '';

    sendFBEvent({
      event_name,
      event_id,
      event_source_url,
      action_source: 'website',
      user_data: {
        ...(user_data || {}),
        client_ip_address: ip,
        client_user_agent: userAgent,
      },
      custom_data,
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[FB Event API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process event' },
      { status: 500 },
    );
  }
}
