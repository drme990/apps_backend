import { z } from 'zod';

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
    phone: z.string().trim().optional(),
    country: z.string().trim().optional(),
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
        phone: z.string().trim().min(1),
        country: z.string().trim().optional(),
      })
      .strict(),
    locale: z.string().trim().optional(),
    couponCode: z.string().trim().optional(),
    referralId: z.string().trim().optional(),
    sizeIndex: z.coerce.number().int().nonnegative().optional(),
    paymentOption: z.enum(['full', 'half', 'custom']).optional(),
    customPaymentAmount: z.coerce.number().positive().optional(),
    createAccount: z.boolean().optional(),
    accountPassword: z.string().optional(),
    termsAgreed: z.boolean(),
    reservationData: z.unknown().optional(),
    source: z.enum(['manasik', 'ghadaq']).optional(),
  })
  .strict();

export const webhookSchema = z
  .object({
    ProductCode: z.string().trim().min(1),
    PaymentMethod: z.string().trim().min(1),
    ProductType: z.string().trim().min(1),
    Amount: z.string().trim().min(1),
    BuyerEmail: z.string().trim().optional().default(''),
    BuyerMobile: z.string().trim().optional().default(''),
    BuyerName: z.string().trim().optional().default(''),
    Timestamp: z.string().trim().min(1),
    status: z.string().trim().min(1),
    voucher: z.string().trim().optional().default(''),
    easykashRef: z.string().trim().min(1),
    VoucherData: z.string().trim().optional().default(''),
    customerReference: z.string().trim().min(1),
    signatureHash: z.string().trim().min(1),
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

export const uploadImageFormSchema = z.object({
  file: z.any(), // File object is checked in route via formData
  oldUrl: z.string().trim().optional(),
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
  })
  .strict();

export const userUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    role: z.enum(['admin', 'super_admin']).optional(),
    allowedPages: z.array(z.string().trim().min(1)).optional(),
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
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
  })
  .strict();

export const countryUpdateSchema = z
  .object({
    code: z.string().trim().min(2).optional(),
    name: localizedTextSchema.optional(),
    currencyCode: z.string().trim().min(3).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
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
    value: z.coerce.number().positive(),
    maxUses: z.coerce.number().nonnegative().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    minOrderAmount: z.coerce.number().nonnegative().optional(),
    maxDiscountAmount: z.coerce.number().nonnegative().optional(),
    status: z.enum(['active', 'expired', 'disabled']).optional(),
    description_ar: z.string().optional(),
    description_en: z.string().optional(),
  })
  .strict();

export const couponUpdateSchema = z
  .object({
    code: z.string().trim().min(1).optional(),
    type: z.enum(['percentage', 'fixed']).optional(),
    value: z.coerce.number().positive().optional(),
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
    phone: z.string().trim().min(1),
  })
  .strict();

export const referralUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    referralId: z.string().trim().min(1).optional(),
    phone: z.string().trim().min(1).optional(),
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
      .default([]),
  })
  .strict();

export const appearanceUpdateSchema = z.record(z.string(), z.any()); // Allowed flexibility here

export const orderStatusUpdateSchema = z
  .object({
    status: z.string().trim().min(1),
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
