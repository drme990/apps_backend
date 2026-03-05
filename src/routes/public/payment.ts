import { Router, Request, Response } from 'express';
import Order from '../../models/Order';
import Product from '../../models/Product';
import Referral from '../../models/Referral';
import {
  createPayment,
  verifyCallbackSignature,
  type EasykashCallbackPayload,
} from '../../services/easykash';
import { validateCoupon, applyCoupon } from '../../services/coupon';
import { trackInitiateCheckout, trackPurchase } from '../../services/fb-capi';
import { sendOrderConfirmationEmail } from '../../services/email';

const router = Router();

// POST /api/payment/checkout — Create order + EasyKash payment
router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const {
      productId,
      quantity = 1,
      currency,
      billingData,
      locale = 'ar',
      couponCode,
      referralId,
      sizeIndex,
      paymentOption = 'full',
      customPaymentAmount,
      termsAgreed,
      notes,
      source,
    } = req.body;

    if (!termsAgreed) {
      res.status(400).json({
        success: false,
        error: 'Terms and conditions must be agreed to',
      });
      return;
    }

    if (!productId || !currency || !billingData) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: productId, currency, billingData',
      });
      return;
    }

    if (!billingData.fullName || !billingData.email || !billingData.phone) {
      res.status(400).json({
        success: false,
        error: 'Billing data must include: fullName, email, phone',
      });
      return;
    }

    const product = await Product.findById(productId);
    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found' });
      return;
    }

    if (!product.inStock) {
      res
        .status(400)
        .json({ success: false, error: 'Product is out of stock' });
      return;
    }

    const currencyUpper = currency.toUpperCase();

    const activeSizeIndex =
      sizeIndex !== undefined &&
      sizeIndex !== null &&
      sizeIndex >= 0 &&
      sizeIndex < product.sizes.length
        ? sizeIndex
        : 0;
    const selectedSize = product.sizes[activeSizeIndex];
    let unitPrice = selectedSize.price ?? 0;

    const sizeCurrencyPrice = selectedSize.prices?.find(
      (p: { currencyCode: string; amount: number }) =>
        p.currencyCode === currencyUpper,
    );
    if (sizeCurrencyPrice) {
      unitPrice = sizeCurrencyPrice.amount;
    } else if (product.baseCurrency !== currencyUpper) {
      res.status(400).json({
        success: false,
        error: `Price not available in ${currencyUpper}. Available in: ${product.baseCurrency}`,
      });
      return;
    }

    if (unitPrice <= 0) {
      res.status(400).json({
        success: false,
        error: `Product price is not configured for ${currencyUpper}`,
      });
      return;
    }

    const totalAmount = unitPrice * quantity;

    let couponDiscount = 0;
    let appliedCouponCode: string | undefined;
    if (couponCode) {
      const couponResult = await validateCoupon(
        couponCode,
        totalAmount,
        currencyUpper,
        productId,
      );
      if (!couponResult.valid) {
        res.status(400).json({ success: false, error: couponResult.error });
        return;
      }
      couponDiscount = couponResult.discountAmount || 0;
      appliedCouponCode = couponResult.coupon?.code;
    }

    const amountAfterDiscount = totalAmount - couponDiscount;

    let payAmount = amountAfterDiscount;
    let isPartialPayment = false;

    if (paymentOption === 'half') {
      isPartialPayment = true;
      payAmount = Math.ceil(amountAfterDiscount / 2);
    } else if (paymentOption === 'custom' && customPaymentAmount) {
      if (!product.partialPayment?.isAllowed) {
        res.status(400).json({
          success: false,
          error: 'This product does not support custom payment amounts',
        });
        return;
      }

      let minPayment = Math.ceil(amountAfterDiscount / 2);
      const minimumPaymentType =
        product.partialPayment?.minimumType || 'percentage';
      const currencyMinimum = product.partialPayment?.minimumPayments?.find(
        (mp: { currencyCode: string; value: number }) =>
          mp.currencyCode === currencyUpper,
      );

      if (currencyMinimum) {
        if (minimumPaymentType === 'percentage') {
          minPayment = Math.ceil(
            (amountAfterDiscount * currencyMinimum.value) / 100,
          );
        } else {
          minPayment = currencyMinimum.value;
        }
      }

      if (customPaymentAmount < minPayment) {
        res.status(400).json({
          success: false,
          error: `Minimum payment amount is ${minPayment} ${currencyUpper}`,
        });
        return;
      }
      if (customPaymentAmount >= amountAfterDiscount) {
        payAmount = amountAfterDiscount;
        isPartialPayment = false;
      } else {
        isPartialPayment = true;
        payAmount = customPaymentAmount;
      }
    }

    const order = await Order.create({
      items: [
        {
          productId: product._id.toString(),
          productName: { ar: product.name.ar, en: product.name.en },
          price: unitPrice,
          currency: currencyUpper,
          quantity,
        },
      ],
      totalAmount: payAmount,
      fullAmount: amountAfterDiscount,
      paidAmount: payAmount,
      remainingAmount: isPartialPayment ? amountAfterDiscount - payAmount : 0,
      isPartialPayment,
      currency: currencyUpper,
      status: 'pending',
      billingData: {
        fullName: billingData.fullName,
        email: billingData.email,
        phone: billingData.phone,
        country: billingData.country || 'N/A',
      },
      referralId: referralId || undefined,
      couponCode: appliedCouponCode,
      couponDiscount,
      termsAgreedAt: new Date(),
      notes: notes || undefined,
      source: source === 'ghadaq' ? 'ghadaq' : 'manasik',
      countryCode: billingData.country || '',
      locale,
    });

    if (appliedCouponCode) {
      await applyCoupon(appliedCouponCode);
    }

    // FB CAPI: InitiateCheckout (fire-and-forget)
    const reqIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.ip ||
      '';
    const reqUa = req.headers['user-agent'] || '';

    trackInitiateCheckout({
      productId: product._id.toString(),
      productName: product.name.en || product.name.ar,
      value: payAmount,
      currency: currencyUpper,
      numItems: quantity,
      sourceUrl: `${process.env.BASE_URL || 'https://www.manasik.net'}/checkout`,
      userData: {
        em: billingData.email,
        ph: billingData.phone,
        fn: billingData.fullName.split(' ')[0],
        ln:
          billingData.fullName.split(' ').slice(1).join(' ') ||
          billingData.fullName.split(' ')[0],
        country: billingData.country,
        client_ip_address: reqIp,
        client_user_agent: reqUa,
        external_id: order._id.toString(),
      },
    }).catch(() => {});

    // EasyKash payment
    if (!process.env.EASYKASH_API_KEY) {
      res.json({
        success: true,
        data: {
          order: {
            _id: order._id,
            orderNumber: order.orderNumber,
            totalAmount: payAmount,
            fullAmount: amountAfterDiscount,
            remainingAmount: isPartialPayment
              ? amountAfterDiscount - payAmount
              : 0,
            isPartialPayment,
            couponDiscount,
            currency: currencyUpper,
            status: order.status,
          },
          checkoutUrl: null,
          message:
            'Payment gateway not configured. Order created successfully.',
        },
      });
      return;
    }

    // Determine the redirect base URL based on order source
    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadqplus.com',
    };
    const baseUrl =
      sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

    const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
    let easykashAmount = payAmount;
    let paymentCurrency = currencyUpper;

    if (!EASYKASH_CURRENCIES.includes(currencyUpper)) {
      const egpPriceEntry = selectedSize.prices?.find(
        (p: { currencyCode: string; amount: number }) =>
          p.currencyCode === 'EGP',
      );
      const egpUnitPrice = egpPriceEntry?.amount ?? unitPrice;
      const egpTotal = egpUnitPrice * quantity;
      const couponRatio = totalAmount > 0 ? couponDiscount / totalAmount : 0;
      const egpAfterDiscount = egpTotal - egpTotal * couponRatio;
      const payRatio =
        amountAfterDiscount > 0 ? payAmount / amountAfterDiscount : 1;
      // Use Math.ceil to produce a whole-number EGP amount — EasyKash requires amount > 1
      easykashAmount = Math.ceil(egpAfterDiscount * payRatio);
      paymentCurrency = 'EGP';
    }

    if (easykashAmount <= 1) {
      // EasyKash requires amount > 1 strictly — clean up the orphan pending order
      await Order.findByIdAndDelete(order._id);
      res.status(400).json({
        success: false,
        error: `Payment amount is too low. Minimum accepted by the payment gateway is 2 ${paymentCurrency}.`,
      });
      return;
    }

    const easykashResponse = await createPayment({
      amount: easykashAmount,
      currency: paymentCurrency,
      name: billingData.fullName,
      email: billingData.email,
      mobile: billingData.phone,
      redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
      customerReference: order.orderNumber,
    });

    order.status = 'processing';
    await order.save();

    res.json({
      success: true,
      data: {
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          totalAmount: payAmount,
          fullAmount: amountAfterDiscount,
          remainingAmount: isPartialPayment
            ? amountAfterDiscount - payAmount
            : 0,
          isPartialPayment,
          couponDiscount,
          currency: currencyUpper,
          status: order.status,
        },
        checkoutUrl: easykashResponse.redirectUrl,
      },
    });
  } catch (error) {
    console.error('Error creating checkout:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to create checkout' });
  }
});

// GET /api/payment/status?orderNumber=XXX — Full order status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const orderNumber = req.query.orderNumber as string;

    if (!orderNumber) {
      res
        .status(400)
        .json({ success: false, error: 'Missing orderNumber parameter' });
      return;
    }

    const order = await Order.findOne({ orderNumber }).lean();

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    let referralInfo: { name: string; phone: string } | null = null;
    if (order.referralId) {
      const referral = await Referral.findOne({
        referralId: order.referralId,
      }).lean();
      if (referral) {
        referralInfo = {
          name: referral.name as string,
          phone: referral.phone as string,
        };
      }
    }

    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
        totalAmount: order.totalAmount,
        currency: order.currency,
        items: order.items,
        billingData: order.billingData,
        couponCode: order.couponCode || null,
        couponDiscount: order.couponDiscount || 0,
        isPartialPayment: order.isPartialPayment || false,
        fullAmount: order.fullAmount || order.totalAmount,
        paidAmount: order.paidAmount || order.totalAmount,
        remainingAmount: order.remainingAmount || 0,
        notes: order.notes || null,
        source: order.source || 'manasik',
        referralInfo,
        createdAt: order.createdAt,
      },
    });
  } catch (error) {
    console.error('Error fetching payment status:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch payment status' });
  }
});

// POST /api/payment/webhook — EasyKash callback
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const body: EasykashCallbackPayload = req.body;

    if (process.env.EASYKASH_HMAC_SECRET) {
      const isValid = verifyCallbackSignature(body);
      if (!isValid) {
        console.error('Invalid signature in EasyKash webhook callback');
        res.status(403).json({ success: false, error: 'Invalid signature' });
        return;
      }
    }

    const {
      customerReference,
      status,
      easykashRef,
      ProductCode,
      voucher,
      PaymentMethod,
      Amount,
    } = body;

    if (!customerReference) {
      console.error('No customerReference in EasyKash callback');
      res.status(400).json({ success: false, error: 'No customerReference' });
      return;
    }

    const order = await Order.findOne({ orderNumber: customerReference });

    if (!order) {
      console.error(
        `Order not found for customerReference: ${customerReference}`,
      );
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    order.easykashRef = easykashRef;
    order.easykashProductCode = ProductCode;
    order.easykashVoucher = voucher;
    order.easykashResponse = {
      status,
      PaymentMethod,
      Amount,
      ProductCode,
      easykashRef,
      voucher,
      BuyerEmail: body.BuyerEmail,
      BuyerMobile: body.BuyerMobile,
      BuyerName: body.BuyerName,
      Timestamp: body.Timestamp,
    } as any;

    const methodLower = (PaymentMethod || '').toLowerCase();
    if (
      methodLower.includes('credit') ||
      methodLower.includes('debit') ||
      methodLower.includes('card')
    ) {
      order.paymentMethod = 'card';
    } else if (methodLower.includes('wallet')) {
      order.paymentMethod = 'wallet';
    } else if (methodLower.includes('fawry')) {
      order.paymentMethod = 'fawry';
    } else if (methodLower.includes('meeza')) {
      order.paymentMethod = 'meeza';
    } else if (methodLower.includes('valu')) {
      order.paymentMethod = 'valu';
    } else {
      order.paymentMethod = 'other';
    }

    if (status === 'PAID') {
      order.status = 'paid';
    } else if (status === 'FAILED' || status === 'EXPIRED') {
      order.status = 'failed';
    } else if (status === 'REFUNDED') {
      order.status = 'refunded';
    } else if (status === 'NEW' || status === 'PENDING') {
      order.status = 'processing';
    } else {
      order.status = 'processing';
    }

    await order.save();

    // FB CAPI: Purchase
    if (order.status === 'paid' && order.items?.length > 0) {
      const item = order.items[0];
      const sourceBaseUrls: Record<string, string> = {
        manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
        ghadaq: process.env.GHADAQ_URL || 'https://www.ghadqplus.com',
      };
      const baseUrl =
        sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

      trackPurchase({
        productId: item.productId,
        productName: item.productName?.en || item.productName?.ar || '',
        value: order.totalAmount ?? order.paidAmount ?? 0,
        currency: order.currency || 'SAR',
        numItems: item.quantity || 1,
        orderId: order.orderNumber,
        sourceUrl: `${baseUrl}/payment/status`,
        userData: {
          em: order.billingData?.email,
          ph: order.billingData?.phone,
          fn: order.billingData?.fullName?.split(' ')[0],
          ln:
            order.billingData?.fullName?.split(' ').slice(1).join(' ') ||
            order.billingData?.fullName?.split(' ')[0],
          country: order.billingData?.country || order.countryCode,
          external_id: order._id.toString(),
        },
      }).catch(() => {});
    }

    // Send order confirmation email for paid orders (fire-and-forget)
    if (order.status === 'paid') {
      sendOrderConfirmationEmail(order.toObject() as any).catch(() => {});
    }

    console.log(
      `EasyKash webhook: Order ${order.orderNumber} → ${order.status} (ref: ${easykashRef})`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error processing EasyKash webhook:', error);
    res
      .status(500)
      .json({ success: false, error: 'Webhook processing failed' });
  }
});

// GET /api/payment/referral-info?orderNumber=XXX
router.get('/referral-info', async (req: Request, res: Response) => {
  try {
    const orderNumber = req.query.orderNumber as string;

    if (!orderNumber) {
      res.json({ success: true, data: null });
      return;
    }

    const order = await Order.findOne({ orderNumber });

    if (!order || !order.referralId) {
      res.json({ success: true, data: null });
      return;
    }

    const referral = await Referral.findOne({ referralId: order.referralId });

    if (!referral) {
      res.json({ success: true, data: null });
      return;
    }

    res.json({
      success: true,
      data: { name: referral.name, phone: referral.phone },
    });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    res.json({ success: true, data: null });
  }
});

export default router;
