import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';
import Product from '@/lib/models/Product';
import { mapEasykashStatusToOrderStatus } from '@/lib/services/easykash';
import {
  markWhatsappButtonClicked,
  resolveWhatsappButtonState,
} from '@/lib/services/whatsapp-button-state';
import {
  calculateOrderFinancials,
  getPaymentOrderAmount,
} from '@/lib/services/order-financials';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REF_REGEX = /^ord_([a-f\d]{24})_[a-f\d]{24}_\d+$/i;
// Old: ABC-202606-12345 | New: MNK-D-2606-123-0003
const ORDER_NUMBER_REGEX =
  /^([A-Za-z]{3}-\d{6}-\d{5}|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d{4,6}-\d+-\d{4})$/i;
const ORDER_NUMBER_ATTEMPT_REGEX =
  /^([A-Za-z]{3}-\d{6}-\d{5}|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d{4,6}-\d+-\d{4})-[pP]\d+$/i;

function getOrderIdFromReference(
  customerReference: string | null,
): string | null {
  if (!customerReference) return null;

  if (OBJECT_ID_REGEX.test(customerReference)) {
    return customerReference;
  }

  const prefixedMatch = customerReference.match(ORDER_REF_REGEX);
  if (prefixedMatch) {
    return prefixedMatch[1];
  }

  return null;
}

function normalizeOrderNumber(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (ORDER_NUMBER_REGEX.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  const attemptMatch = trimmed.match(ORDER_NUMBER_ATTEMPT_REGEX);
  if (attemptMatch) {
    return attemptMatch[1].toUpperCase();
  }

  return null;
}

function mapPaymentMethod(
  methodRaw: string | null,
): 'card' | 'wallet' | 'bank_transfer' | 'fawry' | 'meeza' | 'valu' | 'other' {
  const method = (methodRaw || '').toLowerCase();

  if (method.includes('card')) return 'card';
  if (method.includes('wallet')) return 'wallet';
  if (method.includes('bank')) return 'bank_transfer';
  if (method.includes('fawry')) return 'fawry';
  if (method.includes('meeza')) return 'meeza';
  if (method.includes('valu')) return 'valu';
  return 'other';
}

function hasPaidPayments(
  payments: Array<{ status?: string; amount?: number }> | undefined,
): boolean {
  return (payments || []).some((payment) => payment.status === 'paid');
}

function touchStatusUpdateTime(order: { statusUpdateTime?: Date }): void {
  order.statusUpdateTime = new Date();
}

async function findOrderForPaymentStatus(
  request: NextRequest,
): Promise<Awaited<ReturnType<typeof Order.findOne>> | null> {
  const orderNumberParam = request.nextUrl.searchParams.get('orderNumber');
  const customerReference =
    request.nextUrl.searchParams.get('customerReference');
  const orderNumber = normalizeOrderNumber(orderNumberParam);

  // Case-insensitive order number query (DB may store lowercase)
  const findByOrderNumber = async (num: string) => {
    const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Order.findOne({ orderNumber: { $regex: `^${escaped}$`, $options: 'i' } })
      .sort({ createdAt: -1 })
      .exec();
  };

  let order = orderNumber ? await findByOrderNumber(orderNumber) : null;

  if (!order && customerReference) {
    const resolvedOrderId = getOrderIdFromReference(customerReference);
    if (resolvedOrderId) {
      order = await Order.findById(resolvedOrderId);
    }

    if (!order) {
      const orderNumberFromReference = normalizeOrderNumber(customerReference);
      if (orderNumberFromReference) {
        order = await findByOrderNumber(orderNumberFromReference);
      }
    }

    if (!order) {
      // Last resort: try the raw customerReference as order number (case-insensitive)
      order = await findByOrderNumber(customerReference);
    }
  }

  return order;
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const orderNumberParam = request.nextUrl.searchParams.get('orderNumber');
    const orderNumber = normalizeOrderNumber(orderNumberParam);
    const customerReference =
      request.nextUrl.searchParams.get('customerReference');
    const gatewayStatus = request.nextUrl.searchParams.get('status');
    const providerRefNum = request.nextUrl.searchParams.get('providerRefNum');
    const paymentMethod = request.nextUrl.searchParams.get('paymentMethod');

    if (!orderNumber && !customerReference) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing orderNumber/customerReference parameter',
        },
        { status: 400 },
      );
    }

    const order = await findOrderForPaymentStatus(request);

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    // Front-channel fallback sync: update status using gateway redirect params.
    // This protects the user flow when webhook delivery is delayed or unavailable.
    if (gatewayStatus) {
      const previousStatus = order.status;
      const resolvedOrderId = getOrderIdFromReference(customerReference);
      const resolvedOrderNumber = normalizeOrderNumber(customerReference);
      const matchesCustomerReference =
        !customerReference ||
        customerReference === order._id?.toString() ||
        customerReference === order.orderNumber ||
        resolvedOrderNumber === order.orderNumber ||
        resolvedOrderId === order._id?.toString();

      if (matchesCustomerReference) {
        const mappedStatus = mapEasykashStatusToOrderStatus(gatewayStatus);
        const matchedPayment = (order.payments || []).find(
          (payment) => payment.easykashOrderId === customerReference,
        );
        let shouldSave = false;

        if (mappedStatus === 'paid') {
          if (matchedPayment && matchedPayment.status !== 'paid') {
            const normalizedOrderAmount = getPaymentOrderAmount(
              order,
              matchedPayment,
            );
            if (normalizedOrderAmount > 0) {
              matchedPayment.orderAmount = normalizedOrderAmount;
            }

            matchedPayment.status = 'paid';
            matchedPayment.paidAt = new Date();
            shouldSave = true;
          }

          const { totalPaid, remainingAmount } =
            calculateOrderFinancials(order);

          if (hasPaidPayments(order.payments)) {
            order.paidAmount = totalPaid;
            order.remainingAmount = remainingAmount;

            const targetStatus = remainingAmount <= 0 ? 'paid' : 'partial-paid';

            if (order.status !== targetStatus) {
              order.status = targetStatus;
              touchStatusUpdateTime(order);
              shouldSave = true;
            }
          }
        } else {
          const shouldUpdateStatus =
            order.status !== mappedStatus &&
            order.status !== 'paid' &&
            order.status !== 'processing' &&
            order.status !== 'partial-paid';

          if (shouldUpdateStatus) {
            order.status = mappedStatus;
            touchStatusUpdateTime(order);
            shouldSave = true;
          }
        }

        const nextWhatsappState = resolveWhatsappButtonState(
          order.status,
          previousStatus,
          order.isWhatsappButtonClicked,
        );
        if (nextWhatsappState !== order.isWhatsappButtonClicked) {
          order.isWhatsappButtonClicked = nextWhatsappState;
          shouldSave = true;
        }

        if (matchedPayment) {
          if (providerRefNum) {
            matchedPayment.easykashRef = providerRefNum;
          }

          if (paymentMethod) {
            matchedPayment.paymentMethod = mapPaymentMethod(paymentMethod);
          }

          matchedPayment.easykashResponse = {
            ...(matchedPayment.easykashResponse || {}),
            status: gatewayStatus,
            easykashRef: providerRefNum || matchedPayment.easykashRef,
            PaymentMethod:
              paymentMethod || matchedPayment.easykashResponse?.PaymentMethod,
            customerReference: customerReference || undefined,
            source: 'redirect',
          };
          shouldSave = true;
        }

        if (shouldSave) {
          await order.save();
        }
      }
    }

    const orderObj = order.toObject();

    let referralInfo: { name: string; phone: string } | null = null;
    if (orderObj.referralId) {
      const referral = await Referral.findOne({
        referralId: orderObj.referralId,
      }).lean();
      if (referral) {
        referralInfo = {
          name: referral.name as string,
          phone: referral.phone as string,
        };
      }
    }

    const items = Array.isArray(orderObj.items) ? [...orderObj.items] : [];
    const missingSlugIds = items
      .filter(
        (item) =>
          !item.productSlug &&
          typeof item.productId === 'string' &&
          OBJECT_ID_REGEX.test(item.productId),
      )
      .map((item) => item.productId);

    if (missingSlugIds.length > 0) {
      const products = await Product.find(
        { _id: { $in: missingSlugIds as unknown as string[] } },
        { _id: 1, slug: 1 },
      ).lean();

      const slugById = new Map(
        products.map((product) => [String(product._id), product.slug]),
      );

      for (const item of items) {
        if (!item.productSlug && item.productId) {
          item.productSlug = slugById.get(String(item.productId)) || undefined;
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        orderNumber: orderObj.orderNumber,
        status: orderObj.status,
        totalAmount: orderObj.totalAmount,
        currency: orderObj.currency,
        items,
        billingData: orderObj.billingData,
        couponCode: orderObj.couponCode || null,
        couponDiscount: orderObj.couponDiscount ?? 0,
        isPartialPayment: orderObj.isPartialPayment ?? false,
        isWhatsappButtonClicked:
          orderObj.isWhatsappButtonClicked ?? 'no-need-to-click',
        fullAmount: orderObj.fullAmount ?? orderObj.totalAmount,
        paidAmount: orderObj.paidAmount ?? 0,
        remainingAmount: orderObj.remainingAmount ?? 0,
        reservationData: orderObj.reservationData || [],
        referralId: orderObj.referralId || null,
        source: orderObj.source ?? 'manasik',
        referralInfo,
        createdAt: orderObj.createdAt,
      },
    });
  } catch (error) {
    console.error('Error fetching payment status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch payment status' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = (await request.json()) as {
      orderNumber?: string;
      customerReference?: string;
    };

    const orderNumber = normalizeOrderNumber(body.orderNumber || null);
    const customerReference = body.customerReference?.trim() || null;

    const lookupRequest = new NextRequest(request.url, {
      method: 'GET',
      headers: request.headers,
    });
    if (orderNumber) {
      lookupRequest.nextUrl.searchParams.set('orderNumber', orderNumber);
    }
    if (customerReference) {
      lookupRequest.nextUrl.searchParams.set(
        'customerReference',
        customerReference,
      );
    }

    const order = await findOrderForPaymentStatus(lookupRequest);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const nextWhatsappState = markWhatsappButtonClicked(
      order.isWhatsappButtonClicked,
      order.status,
    );
    if (nextWhatsappState !== order.isWhatsappButtonClicked) {
      order.isWhatsappButtonClicked = nextWhatsappState;
      await order.save();
    }

    return NextResponse.json({
      success: true,
      data: { isWhatsappButtonClicked: order.isWhatsappButtonClicked },
    });
  } catch (error) {
    console.error('Error updating WhatsApp click state:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update WhatsApp click state' },
      { status: 500 },
    );
  }
}
