import { NextRequest, NextResponse } from 'next/server';
import { sendSnapEvent } from '@/lib/services/snapchat-capi';
import { captureException } from '@/lib/services/error-monitor';
import { parseJsonBody } from '@/lib/validation/http';
import { snapEventSchema } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, snapEventSchema);
    if (!parsed.success) return parsed.response;
    const { event_name, event_id, event_source_url, user_data, custom_data } =
      parsed.data;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const userAgent = request.headers.get('user-agent') || '';

    sendSnapEvent({
      event_name,
      event_id,
      event_source_url,
      action_source: 'website',
      user_data: {
        ...(user_data || {}),
        // Prefer values forwarded in the body — the bridge request's
        // own headers only reflect the caller's transport, not the
        // end visitor, when the call is server-to-server.
        client_ip_address: user_data?.client_ip_address || ip,
        client_user_agent: user_data?.client_user_agent || userAgent,
      },
      custom_data:
        custom_data || event_id
          ? {
            ...(custom_data || {}),
            // Snap's template keeps event_id inside custom_data too —
            // ensure it's present even when the client only sent the
            // top-level field.
            ...(event_id ? { event_id } : {}),
          }
          : undefined,
    }).catch((snapError) => {
      captureException(snapError, {
        service: 'SnapchatCAPI',
        operation: 'sendSnapEvent',
        severity: 'low',
        metadata: { event_name, event_id },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    captureException(error, {
      service: 'SnapchatCAPI_Route',
      operation: 'POST',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to process event' },
      { status: 500 },
    );
  }
}
