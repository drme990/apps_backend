import { z } from 'zod';
import { validatePhoneNumber } from './phone-validation';

// ISO 8601 datetime with optional timezone offset (e.g. 2026-06-24T02:00:00+02:00 or 2026-06-24T02:00:00Z)
const isoDateTimeRegex =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isoDateTimeSchema = z
  .string()
  .regex(isoDateTimeRegex, 'Invalid ISO datetime');

// objectLoose was removed or not used

// Standardized ApiError schema response helper
export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.any().optional(),
  }),
});

const localizedTextSchema = z
  .object({
    ar: z.string().min(1),
    en: z.string().min(1),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    appId: z.enum(['manasik', 'ghadaq', 'admin_panel']).optional(),
  })
  .strict();

export const registerSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    phone: z
      .string()
      .trim()
      .optional()
      .refine(
        (phone) => {
          if (!phone) return true; // Phone is optional
          const validation = validatePhoneNumber(phone);
          return validation.isValid;
        },
        {
          message: 'Invalid phone number format',
        },
      ),
    country: z.string().trim().optional(),
    ref: z.string().trim().nullable().optional(),
    registerSource: z.string().trim().optional(),
    appId: z.enum(['manasik', 'ghadaq', 'admin_panel']),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: z.string().email(),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    email: z.string().email(),
    token: z.string().min(10),
    password: z.string().min(6),
  })
  .strict();

export const couponValidationSchema = z
  .object({
    code: z.string().trim().min(1),
    orderAmount: z.coerce.number().positive(),
    currency: z.string().trim().min(1),
    productId: z.string().trim().min(1).optional(),
    detectedCountry: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();

export const checkoutSchema = z
  .object({
    productId: z.string().trim().min(1),
    quantity: z.coerce.number().int().positive().optional(),
    currency: z.string().trim().min(1),
    billingData: z
      .object({
        fullName: z.string().trim().min(1),
        email: z.string().email(),
        phone: z
          .string()
          .trim()
          .min(1)
          .refine(
            (phone) => {
              const validation = validatePhoneNumber(phone);
              return validation.isValid;
            },
            {
              message: 'Invalid phone number format',
            },
          ),
        country: z.string().trim().optional(),
      })
      .strict(),
    locale: z.string().trim().optional(),
    couponCode: z.string().trim().optional(),
    ref: z.string().trim().nullable().optional(),
    referralId: z.string().trim().nullable().optional(),
    sizeIndex: z.coerce.number().int().nonnegative().optional(),
    paymentOption: z.enum(['full', 'half', 'custom']).optional(),
    customPaymentAmount: z.coerce.number().positive().optional(),
    deviceFingerprint: z.string().trim().optional(),
    createAccount: z.boolean().optional(),
    accountPassword: z.string().optional(),
    termsAgreed: z.boolean(),
    reservationData: z.unknown().optional(),
    source: z.enum(['manasik', 'ghadaq']).optional(),
    // Upgrade discount fields
    isUpgrade: z.boolean().optional(),
    fromProductId: z.string().trim().optional(),
    upgradeDiscount: z.coerce.number().min(0).max(100).optional(),
    recommendProductId: z.string().trim().optional(),
  })
  .strict();

const requiredWebhookText = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value).trim())
  .refine((value) => value.length > 0, {
    message: 'Required',
  });

const optionalWebhookText = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])
  .transform((value) =>
    value === null || value === undefined ? '' : String(value).trim(),
  );

export const webhookSchema = z
  .object({
    ProductCode: optionalWebhookText,
    PaymentMethod: optionalWebhookText,
    paymentOption: optionalWebhookText,
    ProductType: optionalWebhookText,
    Amount: optionalWebhookText,
    amount: optionalWebhookText,
    currency: optionalWebhookText,
    BuyerEmail: optionalWebhookText,
    BuyerMobile: optionalWebhookText,
    BuyerName: optionalWebhookText,
    Timestamp: optionalWebhookText,
    timestamp: optionalWebhookText,
    status: requiredWebhookText,
    voucher: optionalWebhookText,
    easykashRef: requiredWebhookText,
    VoucherData: optionalWebhookText,
    customerReference: requiredWebhookText,
    signatureHash: optionalWebhookText,
  })
  .passthrough(); // webhook should passthrough in case easykash adds fields

export const fbEventSchema = z
  .object({
    event_name: z.string().trim().min(1),
    event_id: z.string().trim().optional(),
    event_source_url: z.string().trim().optional(),
    user_data: z.record(z.string(), z.any()).optional(),
    custom_data: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export const refTrackerActionSchema = z.enum([
  'session_created',
  'navigate_products',
  'select_product',
  'pay_now',
  'checkout_choice',
  'proceed_to_payment',
]);

export const refTrackerEventSchema = z
  .object({
    appId: z.enum(['manasik', 'ghadaq']),
    sessionNumber: z.string().trim().min(1).max(128),
    userId: z.string().trim().optional(),
    ref: z.string().trim().nullable().optional(),
    action: refTrackerActionSchema,
    path: z.string().trim().min(1).max(512),
    productName: z.string().trim().optional(),
    buttonLabel: z.string().trim().optional(),
    choice: z.string().trim().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export const uploadImageFormSchema = z.object({
  file: z.any(), // File object is checked in route via formData
  oldUrl: z.string().trim().optional(),
  folder: z.enum(['products', 'customers', 'website', 'appearance']).optional(),
});

export const uploadImageDeleteSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export const userCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    role: z.enum(['admin', 'super_admin']).optional(),
    allowedPages: z.array(z.string().trim().min(1)).optional(),
    ref: z.string().trim().optional(),
  })
  .strict();

export const userUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    role: z.enum(['admin', 'super_admin']).optional(),
    allowedPages: z.array(z.string().trim().min(1)).optional(),
    ref: z.string().trim().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const countryCreateSchema = z
  .object({
    code: z.string().trim().min(2),
    name: localizedTextSchema,
    currencyCode: z.string().trim().min(3).optional(),
    roundingRule: z
      .enum([
        'nearest-ten',
        'nearest-five',
        'nearest-fifty',
        'nearest-hundred',
        'ceil',
      ])
      .optional(),
    propagateRoundingToCurrencyCountries: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
    region: z.string().trim().min(1).optional(),
    visibilityMode: z.enum(['all', 'custom']).optional(),
    countriesToSee: z
      .record(
        z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
        z
          .object({
            realPrice: z.boolean().optional(),
            exchangePrice: z.boolean().optional(),
          })
          .refine((value) => !(value.realPrice && value.exchangePrice), {
            message:
              'A country cannot be assigned to both realPrice and exchangePrice',
          })
          .refine((value) => Boolean(value.realPrice || value.exchangePrice), {
            message: 'At least one visibility option must be selected',
          }),
      )
      .optional(),
    allowRate: z
      .object({
        type: z.enum(['percentage', 'fixnumber']),
        value: z.number().min(0),
      })
      .nullable()
      .optional(),
  })
  .strict();

export const countryUpdateSchema = z
  .object({
    code: z.string().trim().min(2).optional(),
    name: localizedTextSchema.optional(),
    currencyCode: z.string().trim().min(3).optional(),
    roundingRule: z
      .enum([
        'nearest-ten',
        'nearest-five',
        'nearest-fifty',
        'nearest-hundred',
        'ceil',
      ])
      .optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
    region: z.string().trim().min(1).optional(),
    visibilityMode: z.enum(['all', 'custom']).optional(),
    countriesToSee: z
      .record(
        z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
        z
          .object({
            realPrice: z.boolean().optional(),
            exchangePrice: z.boolean().optional(),
          })
          .refine((value) => !(value.realPrice && value.exchangePrice), {
            message:
              'A country cannot be assigned to both realPrice and exchangePrice',
          })
          .refine((value) => Boolean(value.realPrice || value.exchangePrice), {
            message: 'At least one visibility option must be selected',
          }),
      )
      .optional(),
    allowRate: z
      .object({
        type: z.enum(['percentage', 'fixnumber']),
        value: z.number().min(0),
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const reorderSchema = z
  .object({
    orderedIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const couponCreateSchema = z
  .object({
    code: z.string().trim().min(1),
    type: z.enum(['percentage', 'fixed']),
    value: z.coerce.number().positive().optional(),
    fixedPrices: z
      .array(
        z
          .object({
            currencyCode: z.string().trim().min(1),
            amount: z.coerce.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    maxDiscountPrices: z
      .array(
        z
          .object({
            currencyCode: z.string().trim().min(1),
            amount: z.coerce.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    allowedCountries: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
      )
      .optional(),
    maxUses: z.coerce.number().nonnegative().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    minOrderAmount: z.coerce.number().nonnegative().optional(),
    maxDiscountAmount: z.coerce.number().nonnegative().optional(),
    status: z.enum(['active', 'expired', 'disabled']).optional(),
    description_ar: z.string().optional(),
    description_en: z.string().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.type === 'percentage') {
      if (typeof payload.value !== 'number' || payload.value <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'value is required for percentage coupons',
          path: ['value'],
        });
      }
      return;
    }

    if (!payload.fixedPrices || payload.fixedPrices.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fixedPrices is required for fixed coupons',
        path: ['fixedPrices'],
      });
    }
  });

export const couponUpdateSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    type: z.enum(['percentage', 'fixed']).optional(),
    value: z.coerce.number().positive().optional(),
    fixedPrices: z
      .array(
        z
          .object({
            currencyCode: z.string().trim().min(1),
            amount: z.coerce.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    maxDiscountPrices: z
      .array(
        z
          .object({
            currencyCode: z.string().trim().min(1),
            amount: z.coerce.number().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    allowedCountries: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
      )
      .optional(),
    maxUses: z.coerce.number().nonnegative().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    minOrderAmount: z.coerce.number().nonnegative().optional(),
    maxDiscountAmount: z.coerce.number().nonnegative().optional(),
    status: z.enum(['active', 'expired', 'disabled']).optional(),
    description_ar: z.string().optional(),
    description_en: z.string().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const referralCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    referralId: z.string().trim().min(1),
    phone: z
      .string()
      .trim()
      .min(1)
      .refine(
        (phone) => {
          const validation = validatePhoneNumber(phone);
          return validation.isValid;
        },
        {
          message: 'Invalid phone number format',
        },
      ),
  })
  .strict();

export const referralUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    referralId: z.string().trim().min(1).optional(),
    phone: z
      .string()
      .trim()
      .min(1)
      .optional()
      .refine(
        (phone) => {
          if (!phone) return true; // Phone is optional
          const validation = validatePhoneNumber(phone);
          return validation.isValid;
        },
        {
          message: 'Invalid phone number format',
        },
      ),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const bookingUpdateSchema = z
  .object({
    blockedExecutionDates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .default([])
      .optional(),
    cutoffTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    lastDayEndAt: isoDateTimeSchema.nullable().optional(),
    defaultExecutionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    prevDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    summerTimeEnabled: z.boolean().optional(),
    paymentMethodTolerances: z
      .record(
        z.string(),
        z.object({
          type: z.enum(['percentage', 'fixnumber']),
          value: z.number().min(0),
        }),
      )
      .nullable()
      .optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const appearanceUpdateSchema = z.record(z.string(), z.any()); // Allowed flexibility here

export const orderStatusUpdateSchema = z
  .object({
    status: z.string().trim().min(1),
    cancellationReason: z.string().trim().optional(),
  })
  .strict();

export const bulkOrderStatusSchema = z
  .object({
    orderIds: z.array(z.string().trim().min(1)).min(1),
    status: z.string().trim().min(1),
  })
  .strict();

export const autoPriceSchema = z
  .object({
    targetCurrencies: z.array(z.string().trim().length(3)).min(1),
  })
  .strict();

export const productCreateSchema = z.record(z.string(), z.any()); // Too complex to strict type without full model
export const productUpdateSchema = z.record(z.string(), z.any());

export const categoryCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    categoryNumber: z.coerce.number().int().positive(),
    color: z
      .string()
      .trim()
      .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a valid hex color'),
    products: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export const categoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    categoryNumber: z.coerce.number().int().positive().optional(),
    color: z
      .string()
      .trim()
      .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a valid hex color')
      .optional(),
    products: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const supplierCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional().or(z.literal('')),
    address: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

export const supplierUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional().or(z.literal('')),
    address: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const supplierOrderItemSchema = z
  .object({
    name: z.string().trim().min(1),
    quantity: z.coerce.number().int().positive(),
    unitPrice: z.coerce.number().nonnegative(),
    total: z.coerce.number().nonnegative(),
  })
  .strict();

export const supplierOrderCreateSchema = z
  .object({
    items: z.array(supplierOrderItemSchema).min(1),
    orderDate: isoDateTimeSchema.optional(),
    notes: z.string().trim().optional(),
    status: z.enum(['pending', 'received', 'cancelled']).optional(),
  })
  .strict();

export const supplierOrderUpdateSchema = z
  .object({
    items: z.array(supplierOrderItemSchema).min(1).optional(),
    orderDate: isoDateTimeSchema.optional(),
    notes: z.string().trim().optional(),
    status: z.enum(['pending', 'received', 'cancelled']).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const transactionCreateSchema = z
  .object({
    amount: z.coerce.number().positive(),
    accountId: z.string().trim().min(1),
    date: isoDateTimeSchema.optional(),
    paymentMethod: z.string().trim().optional(),
    referenceNumber: z.string().trim().optional(),
    linkedOrderId: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    attachment: z.string().trim().optional(),
  })
  .strict();

export const transactionUpdateSchema = z
  .object({
    amount: z.coerce.number().positive().optional(),
    accountId: z.string().trim().optional(),
    date: isoDateTimeSchema.optional(),
    paymentMethod: z.string().trim().optional(),
    referenceNumber: z.string().trim().optional(),
    linkedOrderId: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    attachment: z.string().trim().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

const accountTypeEnum = z.enum([
  'bank_account',
  'digital_wallet',
  'online_bank',
  'cash',
  'credit_card',
  'other',
]);

export const accountCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    type: accountTypeEnum,
    currency: z.string().trim().min(1).max(10).toUpperCase(),
    openingBalance: z.coerce.number().default(0),
    balance: z.coerce.number().default(0),
    notes: z.string().trim().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export const accountUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    type: accountTypeEnum.optional(),
    currency: z.string().trim().min(1).max(10).toUpperCase().optional(),
    openingBalance: z.coerce.number().optional(),
    balance: z.coerce.number().optional(),
    notes: z.string().trim().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const manualOrderCreateSchema = z
  .object({
    source: z.enum(['manasik', 'ghadaq']),
    items: z
      .array(
        z.union([
          z
            .object({
              type: z.literal('existing'),
              productId: z.string().trim().min(1),
              quantity: z.coerce.number().int().positive(),
              sizeIndex: z.coerce.number().int().nonnegative().optional().default(0),
              customPrice: z.coerce.number().min(0).optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('custom'),
              name: z.string().trim().min(1),
              size: z.string().trim().optional(),
              quantity: z.coerce.number().int().positive(),
              price: z.coerce.number().min(0),
            })
            .strict(),
        ]),
      )
      .min(1),
    currency: z.string().trim().min(1).toUpperCase(),
    referralId: z.string().trim().optional(),
    billingData: z
      .object({
        fullName: z.string().trim().optional().default(''),
        email: z.string().email(),
        phone: z.string().trim().min(1),
        country: z.string().trim().min(1),
      })
      .strict(),
    reservationData: z
      .array(
        z.object({
          key: z.string().trim().min(1),
          value: z.string(),
        }),
      )
      .optional()
      .default([]),
    paymentMethod: z.enum(['easykash', 'insta_pay', 'vodafone_cash', 'bank_transfer', 'paypal', 'binance']),
    invoiceUrl: z.string().trim().optional(),
    invoiceStatus: z.enum(['confirmed', 'waiting', 'pending', 'rejected']).optional().default('waiting'),
    invoiceValue: z.coerce.number().min(0).optional().default(0),
    invoiceCurrency: z.string().trim().optional().default('EGP'),
    invoiceUrls: z
      .array(
        z.object({
          url: z.string().trim(),
          invoiceStatus: z.enum(['confirmed', 'waiting', 'pending', 'rejected']).optional().default('waiting'),
          value: z.coerce.number().min(0).optional().default(0),
          currency: z.string().trim().optional().default('EGP'),
        }),
      )
      .optional(),
    locale: z.string().trim().optional().default('ar'),
    userId: z.string().trim().optional(),
    paidAmount: z.coerce.number().min(0).optional(),
  })
  .strict()
  .refine(
    (data) => {
      const fullName = data.billingData.fullName.trim();
      if (fullName) return true;
      const sacrificeFor = data.reservationData.find(
        (r): r is { key: string; value: string } => r.key === 'sacrificeFor',
      )?.value;
      return Boolean(sacrificeFor?.trim());
    },
    {
      message: 'Either customer fullName or a sacrificeFor name is required',
      path: ['billingData', 'fullName'],
    },
  );
