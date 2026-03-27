import { z } from 'zod';

const objectLoose = z.object({}).passthrough();

const localizedTextSchema = z.object({
  ar: z.string().min(1),
  en: z.string().min(1),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  appId: z.enum(['manasik', 'ghadaq', 'admin_panel']).optional(),
});

export const registerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().trim().optional(),
  country: z.string().trim().optional(),
  appId: z.enum(['manasik', 'ghadaq', 'admin_panel']),
});

export const couponValidationSchema = z.object({
  code: z.string().trim().min(1),
  orderAmount: z.coerce.number().positive(),
  currency: z.string().trim().min(1),
  productId: z.string().trim().min(1).optional(),
});

export const checkoutSchema = z
  .object({
    productId: z.string().trim().min(1),
    quantity: z.coerce.number().int().positive().optional(),
    currency: z.string().trim().min(1),
    billingData: z.object({
      fullName: z.string().trim().min(1),
      email: z.email(),
      phone: z.string().trim().min(1),
      country: z.string().trim().optional(),
    }),
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
  .passthrough();

export const webhookSchema = z.object({
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
});

export const fbEventSchema = z
  .object({
    event_name: z.string().trim().min(1),
    event_id: z.string().trim().optional(),
    event_source_url: z.string().trim().optional(),
    user_data: objectLoose.optional(),
    custom_data: objectLoose.optional(),
  })
  .passthrough();

export const uploadImageFormSchema = z.object({
  file: z.custom<File>((value) => value instanceof File, {
    message: 'file is required',
  }),
  oldUrl: z.string().trim().optional(),
});

export const uploadImageDeleteSchema = z.object({
  url: z.string().url(),
});

export const userCreateSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['admin', 'super_admin']).optional(),
  allowedPages: z.array(z.string().trim().min(1)).optional(),
});

export const userUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    role: z.enum(['admin', 'super_admin']).optional(),
    allowedPages: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field must be provided',
  });

export const countryCreateSchema = z
  .object({
    code: z.string().trim().min(2),
    name: localizedTextSchema,
    currencyCode: z.string().trim().min(3).optional(),
  })
  .passthrough();

export const countryUpdateSchema = objectLoose.refine(
  (payload) => Object.keys(payload).length > 0,
  {
    message: 'At least one field must be provided',
  },
);

export const reorderSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1)).min(1),
});

export const couponCreateSchema = z
  .object({
    code: z.string().trim().min(1),
    type: z.enum(['percentage', 'fixed']),
    value: z.coerce.number().positive(),
  })
  .passthrough();

export const couponUpdateSchema = objectLoose.refine(
  (payload) => Object.keys(payload).length > 0,
  {
    message: 'At least one field must be provided',
  },
);

export const referralCreateSchema = z.object({
  name: z.string().trim().min(1),
  referralId: z.string().trim().min(1),
  phone: z.string().trim().min(1),
});

export const referralUpdateSchema = objectLoose.refine(
  (payload) => Object.keys(payload).length > 0,
  {
    message: 'At least one field must be provided',
  },
);

export const bookingUpdateSchema = z.object({
  blockedExecutionDates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .default([]),
});

export const appearanceUpdateSchema = objectLoose;

export const orderStatusUpdateSchema = z.object({
  status: z.string().trim().min(1),
});

export const bulkOrderStatusSchema = z.object({
  orderIds: z.array(z.string().trim().min(1)).min(1),
  status: z.string().trim().min(1),
});

export const autoPriceSchema = z.object({
  targetCurrencies: z.array(z.string().trim().length(3)).min(1),
});

export const productCreateSchema = objectLoose;
export const productUpdateSchema = objectLoose.refine(
  (payload) => Object.keys(payload).length > 0,
  {
    message: 'At least one field must be provided',
  },
);
