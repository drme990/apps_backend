import { NextRequest, NextResponse } from 'next/server';
import { sendOpenAIEvent } from '@/lib/services/openai-capi';
import { captureException } from '@/lib/services/error-monitor';
import { parseJsonBody } from '@/lib/validation/http';
import { openaiEventSchema } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, openaiEventSchema);
    if (!parsed.success) return parsed.response;
    const { event_name, event_id, event_source_url, user_data, custom_data } =
      parsed.data;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const userAgent = request.headers.get('user-agent') || '';

    sendOpenAIEvent({
      event_name,
      event_id,
      event_source_url,
      action_source: 'web',
      user_data: {
        ...(user_data || {}),
        client_ip_address: ip,
        client_user_agent: userAgent,
      },
      custom_data,
    }).catch((oaiError) => {
      captureException(oaiError, {
        service: 'OpenAICAPI',
        operation: 'sendOpenAIEvent',
        severity: 'low',
        metadata: { event_name, event_id },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    captureException(error, {
      service: 'OpenAICAPI_Route',
      operation: 'POST',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to process event' },
      { status: 500 },
    );
  }
}
