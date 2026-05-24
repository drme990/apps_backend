import type { OrderStatus } from '@/lib/models/Order';

export type WhatsappButtonState =
  | 'clicked'
  | 'not-clicked'
  | 'no-need-to-click';

export function resolveWhatsappButtonState(
  status: OrderStatus,
  previousStatus?: OrderStatus,
  currentState?: WhatsappButtonState,
): WhatsappButtonState {
  if (status === 'paid') {
    if (previousStatus === 'partial-paid') {
      return 'not-clicked';
    }

    return currentState === 'clicked' ? 'clicked' : 'not-clicked';
  }

  if (status === 'partial-paid') {
    if (previousStatus === 'partial-paid' && currentState === 'clicked') {
      return 'clicked';
    }

    return 'not-clicked';
  }

  return 'no-need-to-click';
}

export function markWhatsappButtonClicked(
  currentState: WhatsappButtonState | undefined,
  status?: OrderStatus,
): WhatsappButtonState {
  if (status === 'paid' || status === 'partial-paid') {
    return 'clicked';
  }

  return currentState || 'no-need-to-click';
}
