import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';
import Product from '@/lib/models/Product';
import { mapEasykashStatusToOrderStatus } from '@/lib/services/easykash';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REF_REGEX = /^ord_([a-f\d]{24})_[a-f\d]{24}_\d+$/i;

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

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const orderNumber = request.nextUrl.searchParams.get('orderNumber');
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

    let order = orderNumber ? await Order.findOne({ orderNumber }) : null;

    if (!order && customerReference) {
      const resolvedOrderId = getOrderIdFromReference(customerReference);
      if (resolvedOrderId) {
        order = await Order.findById(resolvedOrderId);
      }

      if (!order) {
        order = await Order.findOne({ orderNumber: customerReference });
      }
    }

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    // Front-channel fallback sync: update status using gateway redirect params.
    // This protects the user flow when webhook delivery is delayed or unavailable.
    if (gatewayStatus) {
      const resolvedOrderId = getOrderIdFromReference(customerReference);
      const matchesCustomerReference =
        !customerReference ||
        customerReference === order._id?.toString() ||
        customerReference === order.orderNumber ||
        resolvedOrderId === order._id?.toString();

      if (matchesCustomerReference) {
        const mappedStatus = mapEasykashStatusToOrderStatus(gatewayStatus);
        let shouldSave = false;

        if (mappedStatus === 'paid') {
          const matchedPayment = (order.payments || []).find(
            (payment) => payment.easykashOrderId === customerReference,
          );

          if (matchedPayment && matchedPayment.status !== 'paid') {
            matchedPayment.status = 'paid';
            matchedPayment.paidAt = new Date();
            shouldSave = true;
          }

          const fullAmount = order.fullAmount ?? order.totalAmount ?? 0;
          const totalPaid = (order.payments || []).reduce((sum, payment) => {
            if (payment.status === 'paid') {
              return sum + Number(payment.amount || 0);
            }
            return sum;
          }, 0);
          const remainingAmount = Math.max(0, fullAmount - totalPaid);

          if (hasPaidPayments(order.payments)) {
            order.paidAmount = totalPaid;
            order.remainingAmount = remainingAmount;

            const targetStatus = remainingAmount <= 0 ? 'paid' : 'processing';

            if (order.status !== targetStatus) {
              order.status = targetStatus;
              shouldSave = true;
            }
          }
        } else {
          const shouldUpdateStatus =
            order.status !== mappedStatus &&
            order.status !== 'paid' &&
            order.status !== 'processing';

          if (shouldUpdateStatus) {
            order.status = mappedStatus;
            shouldSave = true;
          }
        }

        if (providerRefNum) {
          order.easykashRef = providerRefNum;
          shouldSave = true;
        }

        if (paymentMethod) {
          order.paymentMethod = mapPaymentMethod(paymentMethod);
          shouldSave = true;
        }

        order.easykashResponse = {
          ...(order.easykashResponse || {}),
          status: gatewayStatus,
          easykashRef: providerRefNum || order.easykashRef,
          PaymentMethod: paymentMethod || order.easykashResponse?.PaymentMethod,
          customerReference: customerReference || undefined,
          source: 'redirect',
        };
        shouldSave = true;

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
        couponDiscount: orderObj.couponDiscount || 0,
        isPartialPayment: orderObj.isPartialPayment || false,
        fullAmount: orderObj.fullAmount || orderObj.totalAmount,
        paidAmount: orderObj.paidAmount || orderObj.totalAmount,
        remainingAmount: orderObj.remainingAmount || 0,
        reservationData: orderObj.reservationData || [],
        referralId: orderObj.referralId || null,
        sizeIndex: orderObj.sizeIndex ?? 0,
        source: orderObj.source || 'manasik',
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
