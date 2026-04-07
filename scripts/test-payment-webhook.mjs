import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

// Set the webhook status to test from here only.
// Allowed examples: PAID, PENDING, FAILED, EXPIRED, DECLINED, CANCELED, CANCELLED, REFUNDED, NEW, SUCCESS.
const TESAT_STATUS = 'FAILED';
const USE_SIGNATURE = false;
const TEST_BYPASS_HEADER = true;

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPaymentOrderAmount(order, payment) {
  const explicitOrderAmount = toPositiveNumber(payment?.orderAmount);
  if (explicitOrderAmount > 0) return explicitOrderAmount;

  const amount = toPositiveNumber(payment?.amount);
  if (amount <= 0) return 0;

  const orderCurrency = String(order?.currency || '')
    .trim()
    .toUpperCase();
  const paymentCurrency = String(payment?.currency || '')
    .trim()
    .toUpperCase();

  if (orderCurrency && paymentCurrency === orderCurrency) {
    return amount;
  }

  const easykashOrderId = String(payment?.easykashOrderId || '');
  if (/-P\d+$/i.test(easykashOrderId)) {
    const totalAmount = toPositiveNumber(order?.totalAmount);
    if (totalAmount > 0) return totalAmount;
  }

  return 0;
}

function getOrderFinancials(order) {
  const fullAmount =
    toPositiveNumber(order?.fullAmount) || toPositiveNumber(order?.totalAmount);

  const totalPaid = (order?.payments || []).reduce((sum, payment) => {
    if (String(payment?.status || '').toLowerCase() !== 'paid') return sum;
    return sum + getPaymentOrderAmount(order, payment);
  }, 0);

  return {
    fullAmount,
    totalPaid,
    remainingAmount: Math.max(0, fullAmount - totalPaid),
  };
}

function selectWebhookPayment(order, financials, webhookStatus) {
  const normalizedStatus = String(webhookStatus || 'PAID').toUpperCase();
  const isPaidLikeStatus =
    normalizedStatus === 'PAID' || normalizedStatus === 'SUCCESS';

  const notPaidPayments = (order?.payments || [])
    .filter((payment) => {
      const status = String(payment?.status || '').toLowerCase();
      return (
        status === 'pending' || status === 'failed' || status === 'expired'
      );
    })
    .sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime();
      const bTime = new Date(b?.createdAt || 0).getTime();
      return bTime - aTime;
    });

  if (notPaidPayments[0]) {
    const payment = notPaidPayments[0];
    const orderAmount =
      getPaymentOrderAmount(order, payment) ||
      toPositiveNumber(payment?.amount) ||
      financials.remainingAmount ||
      toPositiveNumber(order?.totalAmount);
    const gatewayAmount =
      toPositiveNumber(payment?.gatewayAmount) ||
      toPositiveNumber(payment?.amount) ||
      orderAmount;

    return {
      mode: 'existing_attempt',
      customerReference:
        String(payment?.easykashOrderId || '').trim() ||
        String(order.orderNumber),
      orderAmount,
      gatewayAmount,
      gatewayCurrency: String(
        payment?.gatewayCurrency ||
          payment?.currency ||
          order?.currency ||
          'EGP',
      )
        .trim()
        .toUpperCase(),
      payment,
    };
  }

  // For non-paid status tests, prefer reusing the latest existing payment attempt.
  if (!isPaidLikeStatus && (order?.payments || []).length > 0) {
    const latestPayment = [...(order?.payments || [])].sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime();
      const bTime = new Date(b?.createdAt || 0).getTime();
      return bTime - aTime;
    })[0];

    const orderAmount =
      getPaymentOrderAmount(order, latestPayment) ||
      toPositiveNumber(latestPayment?.amount) ||
      financials.remainingAmount ||
      toPositiveNumber(order?.totalAmount);
    const gatewayAmount =
      toPositiveNumber(latestPayment?.gatewayAmount) ||
      toPositiveNumber(latestPayment?.amount) ||
      orderAmount;

    return {
      mode: 'latest_existing',
      customerReference:
        String(latestPayment?.easykashOrderId || '').trim() ||
        String(order.orderNumber),
      orderAmount,
      gatewayAmount,
      gatewayCurrency: String(
        latestPayment?.gatewayCurrency ||
          latestPayment?.currency ||
          order?.currency ||
          'EGP',
      )
        .trim()
        .toUpperCase(),
      payment: latestPayment,
    };
  }

  const paidCount = (order?.payments || []).filter(
    (payment) => String(payment?.status || '').toLowerCase() === 'paid',
  ).length;

  let orderAmount = 0;
  if (financials.totalPaid > 0 && financials.remainingAmount > 0) {
    orderAmount = financials.remainingAmount;
  } else if (String(order?.paymentType || 'full').toLowerCase() === 'full') {
    orderAmount = financials.fullAmount || toPositiveNumber(order?.totalAmount);
  } else {
    // For half/partial orders, totalAmount is the initial amount requested at checkout.
    orderAmount =
      toPositiveNumber(order?.totalAmount) || financials.remainingAmount;
  }

  return {
    mode: 'derived_attempt',
    customerReference: `${String(order.orderNumber)}-P${paidCount + 1}`,
    orderAmount,
    gatewayAmount: orderAmount,
    gatewayCurrency: String(order?.currency || 'EGP')
      .trim()
      .toUpperCase(),
    payment: null,
  };
}

function normalizeTestStatus(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();

  const aliases = {
    PAID: 'PAID',
    SUCCESS: 'SUCCESS',
    PENDING: 'PENDING',
    NEW: 'NEW',
    FAILED: 'FAILED',
    FAIL: 'FAILED',
    EXPIRED: 'EXPIRED',
    DECLINED: 'DECLINED',
    REFUNDED: 'REFUNDED',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELLED',
  };

  const normalized = aliases[raw];
  if (!normalized) {
    throw new Error(
      `Invalid TESAT_STATUS '${value}'. Allowed values: ${Object.keys(aliases).join(', ')}`,
    );
  }

  return normalized;
}

function printUsage() {
  console.log(
    `Usage:\n  node scripts/test-payment-webhook.mjs <orderNumber>\n\nRequired:\n  <orderNumber>         Order number from DB (example: GHD-202604-00012)\n\nConfiguration in file:\n  TESAT_STATUS          Status to test (PAID, PENDING, FAILED, ... )\n  USE_SIGNATURE         true/false (uses EASYKASH_HMAC_SECRET when true)\n  TEST_BYPASS_HEADER    true/false for x-easykash-test-mode header\n\nExample:\n  node scripts/test-payment-webhook.mjs GHD-202604-00012\n`,
  );
}

function buildSignature(payload, secret) {
  const dataToSign = [
    payload.ProductCode,
    payload.Amount,
    payload.ProductType,
    payload.PaymentMethod,
    payload.status,
    payload.easykashRef,
    payload.customerReference,
  ]
    .map((value) => String(value ?? '').trim())
    .join('');

  return crypto.createHmac('sha512', secret).update(dataToSign).digest('hex');
}

async function main() {
  loadEnvFile();

  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    printUsage();
    return;
  }

  if (argv.length !== 1 || argv[0].startsWith('--')) {
    console.error('Provide exactly one argument: <orderNumber>.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  const orderNumber = String(argv[0] || '').trim();
  const status = normalizeTestStatus(TESAT_STATUS);

  const dbUrl = String(process.env.DATA_BASE_URL || '').trim();
  if (!dbUrl) {
    console.error('Missing DATA_BASE_URL environment variable.');
    process.exitCode = 1;
    return;
  }

  const webhookUrl = String(
    process.env.TEST_WEBHOOK_URL || 'http://localhost:3000/api/payment/webhook',
  ).trim();

  await mongoose.connect(dbUrl, {
    bufferCommands: false,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });

  const orders = mongoose.connection.collection('orders');
  const order = await orders.findOne({
    orderNumber: { $regex: `^${escapeRegex(orderNumber)}$`, $options: 'i' },
  });

  if (!order) {
    console.error(`Order not found: ${orderNumber}`);
    process.exitCode = 1;
    return;
  }

  const financials = getOrderFinancials(order);
  const selected = selectWebhookPayment(order, financials, status);
  if (selected.orderAmount <= 0) {
    console.error(
      `Cannot derive payable amount for order ${order.orderNumber}.`,
    );
    process.exitCode = 1;
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const easykashRef = `TEST-${status}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const buyerName =
    String(order?.billingData?.fullName || '').trim() || 'Test Buyer';
  const buyerEmail =
    String(order?.billingData?.email || '').trim() || 'test@example.com';
  const buyerMobile =
    String(order?.billingData?.phone || '').trim() || '01000000000';

  const payload = {
    ProductCode: String(
      selected?.payment?.easykashProductCode || 'TEST-PRODUCT',
    ),
    PaymentMethod: String(
      selected?.payment?.paymentMethod || 'Credit & Debit Card',
    ),
    ProductType: 'Direct Pay',
    Amount: String(selected.gatewayAmount),
    amount: String(selected.gatewayAmount),
    currency: String(selected.gatewayCurrency || order.currency || 'EGP'),
    BuyerEmail: buyerEmail,
    BuyerMobile: buyerMobile,
    BuyerName: buyerName,
    Timestamp: String(nowSeconds),
    status,
    voucher: String(selected?.payment?.easykashVoucher || ''),
    easykashRef,
    VoucherData: `Webhook test callback for ${order.orderNumber}`,
    customerReference: selected.customerReference,
  };

  if (USE_SIGNATURE) {
    const secret = String(process.env.EASYKASH_HMAC_SECRET || '').trim();
    if (!secret) {
      console.error('Cannot use signature mode without EASYKASH_HMAC_SECRET.');
      process.exitCode = 1;
      return;
    }

    payload.signatureHash = buildSignature(payload, secret);
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (TEST_BYPASS_HEADER) {
    headers['x-easykash-test-mode'] = '1';
  }

  console.log('Order resolved from DB:');
  console.log(
    JSON.stringify(
      {
        orderNumber: order.orderNumber,
        paymentType: order.paymentType,
        status: order.status,
        currency: order.currency,
        fullAmount: financials.fullAmount,
        paidAmount: financials.totalPaid,
        remainingAmount: financials.remainingAmount,
        selectedMode: selected.mode,
        selectedReference: selected.customerReference,
        selectedOrderAmount: selected.orderAmount,
        selectedGatewayAmount: selected.gatewayAmount,
        selectedGatewayCurrency: selected.gatewayCurrency,
        configuredStatus: status,
      },
      null,
      2,
    ),
  );

  console.log('Calling webhook with payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`TESAT_STATUS: ${status}`);
  console.log(`Signature mode: ${USE_SIGNATURE ? 'enabled' : 'disabled'}`);
  console.log(
    `Test bypass header: ${TEST_BYPASS_HEADER ? 'enabled' : 'disabled'}`,
  );

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsedBody = null;

  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    parsedBody = rawText;
  }

  console.log(`Response status: ${response.status}`);
  console.log('Response body:');
  console.log(
    typeof parsedBody === 'string'
      ? parsedBody
      : JSON.stringify(parsedBody, null, 2),
  );

  if (!response.ok) {
    process.exitCode = 1;
    return;
  }

  if (
    typeof parsedBody === 'object' &&
    parsedBody &&
    parsedBody.success === false
  ) {
    process.exitCode = 1;
    return;
  }

  console.log('Webhook test call completed successfully.');
}

main()
  .catch((error) => {
    console.error('Webhook test script failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
      }
    } catch {
      // ignore close errors in script shutdown
    }
  });
