import mongoose, { Document, Types } from 'mongoose';

declare const process: {
  env: Record<string, string | undefined>;
  exit: (code?: number) => never;
};

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

type Localized = { ar: string; en: string };

type ReservationField = {
  key?: string;
  type?: string;
  label?: Localized;
  required?: boolean;
  maxLength?: number;
  options?: Localized[];
  supportsMulti?: boolean;
};

type ReservationAnswer = {
  key?: string;
  label?: Localized;
  type?: string;
  value?: string;
};

type ProductDoc = Document & {
  _id: Types.ObjectId;
  reservationFields?: ReservationField[];
};

type OrderDoc = Document & {
  _id: Types.ObjectId;
  reservationData?: ReservationAnswer[];
};

const ProductSchema = new mongoose.Schema(
  {
    reservationFields: [
      {
        key: String,
        type: String,
        label: {
          ar: String,
          en: String,
        },
        required: Boolean,
        maxLength: Number,
        options: [
          {
            ar: String,
            en: String,
          },
        ],
        supportsMulti: Boolean,
      },
    ],
  },
  { strict: false },
);

const OrderSchema = new mongoose.Schema(
  {
    reservationData: [
      {
        key: String,
        label: {
          ar: String,
          en: String,
        },
        type: String,
        value: String,
      },
    ],
  },
  { strict: false },
);

const Product =
  (mongoose.models.Product as mongoose.Model<ProductDoc>) ||
  mongoose.model<ProductDoc>('Product', ProductSchema, 'products');

const Order =
  (mongoose.models.Order as mongoose.Model<OrderDoc>) ||
  mongoose.model<OrderDoc>('Order', OrderSchema, 'orders');

const SACRIFICE_FOR_AR = 'اسم الشخص المؤدى عنه';
const SACRIFICE_FOR_EN = 'The person on whose behalf';

const GENDER_OPTIONS: Localized[] = [
  { ar: 'ذكر', en: 'male' },
  { ar: 'انثى', en: 'female' },
  { ar: 'ذكور و اناث', en: 'Males and females' },
];

const IS_ALIVE_OPTIONS: Localized[] = [
  { ar: 'حي', en: 'Alive' },
  { ar: 'متوفي', en: 'dead' },
];

function normalizeKey(field: { key?: string; label?: Localized }): string {
  if (typeof field.key === 'string' && field.key.trim()) {
    return field.key.trim();
  }

  const ar = field.label?.ar?.trim();
  const en = field.label?.en?.trim().toLowerCase();

  if (ar === 'النية' || en === 'intention') return 'intention';
  if (ar === 'اسم الشخص الذي يذبح عنه' || ar === SACRIFICE_FOR_AR) {
    return 'sacrificeFor';
  }
  if (ar === 'الجنس' || en === 'gender') return 'gender';
  if (ar === 'حي' || en === 'is alive') return 'isAlive';
  if (ar === 'دعاء مختصر' || en === 'short duaa') return 'shortDuaa';
  if (ar === 'صورة' || en === 'photo') return 'photo';
  if (ar?.includes('تاريخ التنفيذ') || en?.includes('execution date')) {
    return 'executionDate';
  }

  return '';
}

function normalizeAliveValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'dead' ||
    normalized === 'deceased' ||
    normalized === 'ميت' ||
    normalized === 'متوفي'
  ) {
    return 'متوفي';
  }
  if (normalized === 'alive' || normalized === 'حي') {
    return 'حي';
  }
  return value.trim();
}

function normalizeGenderValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'male' || normalized === 'ذكر') return 'ذكر';
  if (normalized === 'female' || normalized === 'انثى') return 'انثى';
  if (
    normalized === 'males and females' ||
    normalized === 'ذكور و اناث' ||
    normalized === 'مذكر ومؤنث (أكثر من اسم واحد)'
  ) {
    return 'ذكور و اناث';
  }
  return value.trim();
}

async function migrateProducts() {
  const products = await Product.find({ reservationFields: { $exists: true } });

  let updatedCount = 0;
  for (const product of products) {
    const fields = Array.isArray(product.reservationFields)
      ? product.reservationFields
      : [];

    let changed = false;
    const nextFields = fields.map((field) => {
      const key = normalizeKey(field);
      const next: ReservationField = { ...field };

      if (key && next.key !== key) {
        next.key = key;
        changed = true;
      }

      if (key === 'sacrificeFor') {
        if (
          next.label?.ar !== SACRIFICE_FOR_AR ||
          next.label?.en !== SACRIFICE_FOR_EN
        ) {
          next.label = { ar: SACRIFICE_FOR_AR, en: SACRIFICE_FOR_EN };
          changed = true;
        }
        if (typeof next.supportsMulti !== 'boolean') {
          next.supportsMulti = false;
          changed = true;
        }
      }

      if (key === 'gender') {
        next.options = GENDER_OPTIONS;
        changed = true;
      }

      if (key === 'isAlive') {
        next.options = IS_ALIVE_OPTIONS;
        changed = true;
      }

      return next;
    });

    if (!changed) continue;

    product.reservationFields = nextFields;
    await product.save();
    updatedCount += 1;
  }

  return updatedCount;
}

async function migrateOrders() {
  const orders = await Order.find({ reservationData: { $exists: true } });

  let updatedCount = 0;
  for (const order of orders) {
    const answers = Array.isArray(order.reservationData)
      ? order.reservationData
      : [];

    let changed = false;
    const nextAnswers = answers.map((answer) => {
      const key = normalizeKey(answer);
      const next: ReservationAnswer = { ...answer };

      if (key && next.key !== key) {
        next.key = key;
        changed = true;
      }

      if (key === 'sacrificeFor') {
        if (
          next.label?.ar !== SACRIFICE_FOR_AR ||
          next.label?.en !== SACRIFICE_FOR_EN
        ) {
          next.label = { ar: SACRIFICE_FOR_AR, en: SACRIFICE_FOR_EN };
          changed = true;
        }
      }

      if (key === 'isAlive' && typeof next.value === 'string') {
        const normalizedValue = normalizeAliveValue(next.value);
        if (normalizedValue !== next.value) {
          next.value = normalizedValue;
          changed = true;
        }
      }

      if (key === 'gender' && typeof next.value === 'string') {
        const normalizedValue = normalizeGenderValue(next.value);
        if (normalizedValue !== next.value) {
          next.value = normalizedValue;
          changed = true;
        }
      }

      return next;
    });

    if (!changed) continue;

    order.reservationData = nextAnswers;
    await order.save();
    updatedCount += 1;
  }

  return updatedCount;
}

async function run() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const updatedProducts = await migrateProducts();
    const updatedOrders = await migrateOrders();

    console.log(`Updated products: ${updatedProducts}`);
    console.log(`Updated orders: ${updatedOrders}`);
    console.log('Reservation migration completed successfully');

    process.exit(0);
  } catch (error) {
    console.error('Reservation migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
