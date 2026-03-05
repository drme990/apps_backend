import { Resend } from 'resend';
import type { IOrder } from '../models/Order';

// ─── Brand Configs ───────────────────────────────────────────────
const BRANDS = {
  manasik: {
    name: 'Manasik Foundation',
    nameAr: 'مؤسسة مناسك',
    tagline: 'Islamic Religious Services',
    taglineAr: 'الخدمات الدينية الإسلامية',
    gradientFrom: '#1f8a54',
    gradientTo: '#5cc48f',
    primaryColor: '#33ad6c',
    headerTextColor: '#ffffff',
    footerBg: '#000f2f',
    fromEmail: process.env.MANASIK_FROM_EMAIL || 'orders@manasik.net',
    siteUrl: process.env.MANASIK_URL || 'https://www.manasik.net',
  },
  ghadaq: {
    name: 'Ghadaq Association',
    nameAr: 'جمعية غداق',
    tagline: 'Islamic Religious Services',
    taglineAr: 'الخدمات الدينية الإسلامية',
    gradientFrom: '#ffa401',
    gradientTo: '#ffd84d',
    primaryColor: '#ffc001',
    headerTextColor: '#000f2f',
    footerBg: '#134d37',
    fromEmail: process.env.GHADAQ_FROM_EMAIL || 'orders@ghadqplus.com',
    siteUrl: process.env.GHADAQ_URL || 'https://www.ghadqplus.com',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────
function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(date: Date | string, locale: string): string {
  const d = new Date(date);
  return d.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ─── HTML Template ───────────────────────────────────────────────
function buildEmailHtml(order: IOrder): string {
  const brand = BRANDS[order.source === 'ghadaq' ? 'ghadaq' : 'manasik'];
  const isAr = order.locale === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';
  const textAlign = isAr ? 'right' : 'left';
  const currency = order.currency || 'USD';
  const createdAt = order.createdAt
    ? formatDate(order.createdAt, order.locale || 'ar')
    : '';

  const L = {
    subject: isAr ? 'تم تأكيد طلبك بنجاح' : 'Your Order is Confirmed',
    greeting: isAr
      ? `عزيزي ${order.billingData?.fullName}،`
      : `Dear ${order.billingData?.fullName},`,
    thanks: isAr
      ? 'شكراً لك! لقد تم استلام طلبك بنجاح وتأكيد دفعتك.'
      : 'Thank you! Your order has been received and your payment is confirmed.',
    orderNumber: isAr ? 'رقم الطلب' : 'Order Number',
    orderDate: isAr ? 'تاريخ الطلب' : 'Order Date',
    orderItems: isAr ? 'تفاصيل الطلب' : 'Order Details',
    product: isAr ? 'المنتج' : 'Product',
    quantity: isAr ? 'الكمية' : 'Qty',
    price: isAr ? 'السعر' : 'Price',
    paymentSummary: isAr ? 'ملخص الدفع' : 'Payment Summary',
    subtotal: isAr ? 'الإجمالي' : 'Subtotal',
    discount: isAr ? 'خصم الكوبون' : 'Coupon Discount',
    totalPaid: isAr ? 'المبلغ المدفوع' : 'Amount Paid',
    remaining: isAr ? 'المبلغ المتبقي' : 'Remaining Balance',
    partialNote: isAr
      ? 'هذا دفع جزئي. يُرجى سداد المبلغ المتبقي في الموعد المحدد.'
      : 'This is a partial payment. Please settle the remaining balance as arranged.',
    billingTitle: isAr ? 'بيانات العميل' : 'Customer Details',
    name: isAr ? 'الاسم' : 'Name',
    email: isAr ? 'البريد الإلكتروني' : 'Email',
    phone: isAr ? 'الهاتف' : 'Phone',
    country: isAr ? 'الدولة' : 'Country',
    notesTitle: isAr ? 'ملاحظات' : 'Notes',
    supportTitle: isAr ? 'هل تحتاج مساعدة؟' : 'Need Help?',
    supportText: isAr
      ? 'للاستفسار عن طلبك، تواصل معنا عبر الواتساب أو البريد الإلكتروني.'
      : 'For any questions about your order, contact us via WhatsApp or email.',
    viewOrder: isAr ? 'عرض تفاصيل الطلب' : 'View Order Status',
    footerNote: isAr
      ? 'هذا البريد تم إرساله تلقائياً، يُرجى عدم الرد عليه مباشرة.'
      : 'This is an automated email, please do not reply directly.',
  };

  const itemsRows = order.items
    .map((item) => {
      const name = isAr
        ? item.productName?.ar || item.productName?.en || ''
        : item.productName?.en || item.productName?.ar || '';
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${name}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;text-align:center;">×${item.quantity}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;text-align:${isAr ? 'left' : 'right'};">${formatAmount(item.price * item.quantity, currency)}</td>
        </tr>`;
    })
    .join('');

  const fullAmount = order.fullAmount ?? order.totalAmount ?? 0;
  const paidAmount = order.paidAmount ?? order.totalAmount ?? 0;
  const remainingAmount = order.remainingAmount ?? 0;
  const discount = order.couponDiscount ?? 0;

  const payRows = [
    discount > 0
      ? `<tr>
          <td style="padding:6px 0;font-size:14px;color:#555;">${L.discount} (${order.couponCode})</td>
          <td style="padding:6px 0;font-size:14px;color:#e53e3e;text-align:${isAr ? 'left' : 'right'};">- ${formatAmount(discount, currency)}</td>
        </tr>`
      : '',
    order.isPartialPayment
      ? `<tr>
          <td style="padding:6px 0;font-size:14px;color:#555;">${L.subtotal}</td>
          <td style="padding:6px 0;font-size:14px;color:#333;font-weight:bold;text-align:${isAr ? 'left' : 'right'};">${formatAmount(fullAmount, currency)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:15px;color:#333;font-weight:bold;">${L.totalPaid}</td>
          <td style="padding:8px 0;font-size:15px;color:${brand.primaryColor};font-weight:bold;text-align:${isAr ? 'left' : 'right'};">${formatAmount(paidAmount, currency)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:14px;color:#e07b00;font-weight:bold;">${L.remaining}</td>
          <td style="padding:6px 0;font-size:14px;color:#e07b00;font-weight:bold;text-align:${isAr ? 'left' : 'right'};">${formatAmount(remainingAmount, currency)}</td>
        </tr>`
      : `<tr>
          <td style="padding:8px 0;font-size:16px;color:#333;font-weight:bold;">${L.totalPaid}</td>
          <td style="padding:8px 0;font-size:16px;color:${brand.primaryColor};font-weight:bold;text-align:${isAr ? 'left' : 'right'};">${formatAmount(paidAmount, currency)}</td>
        </tr>`,
  ]
    .filter(Boolean)
    .join('');

  const partialBanner = order.isPartialPayment
    ? `<tr>
        <td style="padding:0 30px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#fff8e6;border:1px solid #ffc001;border-radius:8px;padding:12px 16px;font-size:13px;color:#a07000;">
                ⚠️ ${L.partialNote}
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  const notesSection = order.notes
    ? `<tr>
        <td style="padding:0 30px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.5px;">${L.notesTitle}</p>
                <p style="margin:0;font-size:14px;color:#333;">${order.notes}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  const statusUrl = `${brand.siteUrl}/payment/status?orderNumber=${encodeURIComponent(order.orderNumber)}`;

  return `<!DOCTYPE html>
<html lang="${isAr ? 'ar' : 'en'}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${L.subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f2f5;font-family:Arial,'Helvetica Neue',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5;min-height:100vh;">
    <tr>
      <td align="center" style="padding:30px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
          <tr>
            <td style="background:linear-gradient(135deg,${brand.gradientFrom} 0%,${brand.gradientTo} 100%);padding:36px 30px;text-align:center;">
              <h1 style="margin:0;font-size:26px;font-weight:800;color:${brand.headerTextColor};letter-spacing:-0.5px;">${brand.name}</h1>
              <p style="margin:6px 0 0;font-size:13px;color:${brand.headerTextColor};opacity:0.85;">${brand.nameAr} · ${brand.tagline}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 30px 20px;text-align:center;">
              <div style="display:inline-block;width:64px;height:64px;background:${brand.primaryColor};border-radius:50%;line-height:64px;font-size:30px;color:#fff;margin-bottom:16px;">✓</div>
              <h2 style="margin:0 0 10px;font-size:22px;color:#1a1a2e;">${L.subject}</h2>
              <p style="margin:0;font-size:15px;color:#555;max-width:420px;margin:0 auto;">${L.greeting}<br/><br/>${L.thanks}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 30px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <tr>
                  <td style="padding:12px 16px;font-size:13px;color:#555;border-bottom:1px solid #eee;"><span style="font-weight:bold;color:#1a1a2e;">${L.orderNumber}</span></td>
                  <td style="padding:12px 16px;font-size:14px;color:${brand.primaryColor};font-weight:bold;text-align:${isAr ? 'left' : 'right'};border-bottom:1px solid #eee;">${order.orderNumber}</td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;font-size:13px;color:#555;"><span style="font-weight:bold;color:#1a1a2e;">${L.orderDate}</span></td>
                  <td style="padding:12px 16px;font-size:13px;color:#555;text-align:${isAr ? 'left' : 'right'};">${createdAt}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 30px 24px;">
              <h3 style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.6px;">${L.orderItems}</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background:#f8f9fa;">
                    <th style="padding:10px 12px;font-size:12px;color:#777;font-weight:600;text-align:${textAlign};">${L.product}</th>
                    <th style="padding:10px 12px;font-size:12px;color:#777;font-weight:600;text-align:center;">${L.quantity}</th>
                    <th style="padding:10px 12px;font-size:12px;color:#777;font-weight:600;text-align:${isAr ? 'left' : 'right'};">${L.price}</th>
                  </tr>
                </thead>
                <tbody>${itemsRows}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 30px 24px;">
              <h3 style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.6px;">${L.paymentSummary}</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${brand.primaryColor};">${payRows}</table>
            </td>
          </tr>
          ${partialBanner}
          <tr>
            <td style="padding:0 30px 24px;">
              <h3 style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.6px;">${L.billingTitle}</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <tr>
                  <td style="padding:10px 16px;font-size:13px;color:#777;border-bottom:1px solid #eee;width:40%;">${L.name}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#333;font-weight:600;border-bottom:1px solid #eee;">${order.billingData?.fullName || ''}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;font-size:13px;color:#777;border-bottom:1px solid #eee;">${L.email}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #eee;">${order.billingData?.email || ''}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;font-size:13px;color:#777;border-bottom:1px solid #eee;">${L.phone}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#333;border-bottom:1px solid #eee;">${order.billingData?.phone || ''}</td>
                </tr>
                <tr>
                  <td style="padding:10px 16px;font-size:13px;color:#777;">${L.country}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#333;">${order.billingData?.country || ''}</td>
                </tr>
              </table>
            </td>
          </tr>
          ${notesSection}
          <tr>
            <td style="padding:0 30px 32px;text-align:center;">
              <a href="${statusUrl}" style="display:inline-block;background:linear-gradient(135deg,${brand.gradientFrom},${brand.gradientTo});color:${brand.headerTextColor};text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;">${L.viewOrder}</a>
            </td>
          </tr>
          <tr>
            <td style="background:${brand.footerBg};padding:28px 30px;text-align:center;">
              <p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#fff;">${L.supportTitle}</p>
              <p style="margin:0 0 16px;font-size:13px;color:rgba(255,255,255,0.75);">${L.supportText}</p>
              <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.45);">${L.footerNote}</p>
              <p style="margin:10px 0 0;font-size:12px;color:rgba(255,255,255,0.45);">© ${new Date().getFullYear()} ${brand.name} · ${brand.nameAr}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Public API ──────────────────────────────────────────────────
export async function sendOrderConfirmationEmail(order: IOrder): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      '[Email] RESEND_API_KEY not configured — skipping order confirmation email',
    );
    return;
  }

  const customerEmail = order.billingData?.email;
  if (!customerEmail) {
    console.warn(
      `[Email] Order ${order.orderNumber} has no customer email — skipping`,
    );
    return;
  }

  const brand = BRANDS[order.source === 'ghadaq' ? 'ghadaq' : 'manasik'];
  const isAr = order.locale === 'ar';
  const subject = isAr ? 'تم تأكيد طلبك بنجاح' : 'Your Order is Confirmed';

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: `${brand.name} <${brand.fromEmail}>`,
      to: [customerEmail],
      subject: `${subject} – ${order.orderNumber}`,
      html: buildEmailHtml(order),
    });

    if (error) {
      console.error(
        `[Email] Failed to send order confirmation for ${order.orderNumber}:`,
        error,
      );
    } else {
      console.log(
        `[Email] Order confirmation sent to ${customerEmail} (${order.orderNumber})`,
      );
    }
  } catch (err) {
    console.error(
      `[Email] Unexpected error sending email for ${order.orderNumber}:`,
      err,
    );
  }
}
