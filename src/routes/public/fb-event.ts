import { Router, Request, Response } from 'express';
import { sendFBEvent } from '../../services/fb-capi';

const router = Router();

// POST /api/fb-event — Relay client events to FB Conversions API
router.post('/', async (req: Request, res: Response) => {
  try {
    const { event_name, event_id, event_source_url, user_data, custom_data } =
      req.body;

    if (!event_name) {
      res.status(400).json({ success: false, error: 'event_name is required' });
      return;
    }

    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.ip ||
      '';
    const userAgent = req.headers['user-agent'] || '';

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

    res.json({ success: true });
  } catch (error) {
    console.error('[FB Event API] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to process event' });
  }
});

export default router;
