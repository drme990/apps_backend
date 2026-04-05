import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

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

function selectWebhookPayment(order, financials) {
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

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function printUsage() {
  console.log(
    `Usage:\n  node scripts/test-payment-webhook.mjs <orderNumber> [options]\n\nRequired:\n  <orderNumber>         Order number from DB (example: GHD-202604-00012)\n\nOptions:\n  --url                 Webhook URL (default: http://localhost:3000/api/payment/webhook)\n  --status              Payment status (default: PAID)\n  --paymentMethod       EasyKash payment method (default: Credit & Debit Card)\n  --productCode         EasyKash product code (default: TEST-PRODUCT)\n  --productType         EasyKash product type (default: Direct Pay)\n  --easykashRef         Gateway ref (default: autogenerated)\n  --voucher             Voucher text (default: empty)\n  --testBypass          Send x-easykash-test-mode header (default: true)\n  --useSignature        Attach valid signatureHash using EASYKASH_HMAC_SECRET (default: false)\n\nExamples:\n  node scripts/test-payment-webhook.mjs GHD-202604-00012\n  node scripts/test-payment-webhook.mjs GHD-202604-00012 --status PAID --useSignature true\n`,
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

  const args = parseArgs(process.argv.slice(2));

  if (parseBoolean(args.help, false) || parseBoolean(args.h, false)) {
    printUsage();
    return;
  }

  const orderNumber = String(args.orderNumber || args._[0] || '').trim();
  if (!orderNumber) {
    console.error('Missing order number argument.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  const dbUrl = String(process.env.DATA_BASE_URL || '').trim();
  if (!dbUrl) {
    console.error('Missing DATA_BASE_URL environment variable.');
    process.exitCode = 1;
    return;
  }

  const webhookUrl = String(
    args.url ||
      process.env.TEST_WEBHOOK_URL ||
      'http://localhost:3000/api/payment/webhook',
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
  const selected = selectWebhookPayment(order, financials);
  if (selected.orderAmount <= 0) {
    console.error(
      `Cannot derive payable amount for order ${order.orderNumber}.`,
    );
    process.exitCode = 1;
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const easykashRef =
    String(args.easykashRef || '').trim() ||
    `TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const buyerName =
    String(order?.billingData?.fullName || '').trim() || 'Test Buyer';
  const buyerEmail =
    String(order?.billingData?.email || '').trim() || 'test@example.com';
  const buyerMobile =
    String(order?.billingData?.phone || '').trim() || '01000000000';

  const status = String(args.status || 'PAID').toUpperCase();

  const payload = {
    ProductCode: String(
      args.productCode ||
        selected?.payment?.easykashProductCode ||
        'TEST-PRODUCT',
    ),
    PaymentMethod: String(args.paymentMethod || 'Credit & Debit Card'),
    ProductType: String(args.productType || 'Direct Pay'),
    Amount: String(selected.gatewayAmount),
    amount: String(selected.gatewayAmount),
    currency: String(selected.gatewayCurrency || order.currency || 'EGP'),
    BuyerEmail: buyerEmail,
    BuyerMobile: buyerMobile,
    BuyerName: buyerName,
    Timestamp: String(args.timestamp || nowSeconds),
    status,
    voucher: String(args.voucher || ''),
    easykashRef,
    VoucherData: `Webhook test callback for ${order.orderNumber}`,
    customerReference: selected.customerReference,
  };

  const useSignature = parseBoolean(args.useSignature, false);
  if (useSignature) {
    const secret = String(process.env.EASYKASH_HMAC_SECRET || '').trim();
    if (!secret) {
      console.error('Cannot use signature mode without EASYKASH_HMAC_SECRET.');
      process.exitCode = 1;
      return;
    }

    payload.signatureHash = buildSignature(payload, secret);
  }

  const testBypass = parseBoolean(args.testBypass, true);
  const headers = {
    'Content-Type': 'application/json',
  };

  if (testBypass) {
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
      },
      null,
      2,
    ),
  );

  console.log('Calling webhook with payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`Signature mode: ${useSignature ? 'enabled' : 'disabled'}`);
  console.log(`Test bypass header: ${testBypass ? 'enabled' : 'disabled'}`);

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
