export type ReservationFieldKey =
  | 'intention'
  | 'sacrificeFor'
  | 'gender'
  | 'isAlive'
  | 'shortDuaa'
  | 'photo'
  | 'executionDate';

export type ReservationFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'picture';

export interface ReservationFieldOption {
  ar: string;
  en: string;
}

export interface ReservationFieldConfig {
  key: ReservationFieldKey;
  type: ReservationFieldType;
  label: { ar: string; en: string };
  options?: ReservationFieldOption[];
  supportsMulti?: boolean;
}

export interface ReservationFieldDefinition extends ReservationFieldConfig {
  required: boolean;
  maxLength?: number;
  supportsMulti?: boolean;
}

export interface ReservationAnswerDefinition {
  key: ReservationFieldKey;
  label: { ar: string; en: string };
  type: ReservationFieldType;
  value: string;
}

export const RESERVATION_FIELD_PRESETS: ReservationFieldConfig[] = [
  {
    key: 'intention',
    type: 'select',
    label: { ar: 'النية', en: 'Intention' },
    options: [
      { ar: 'عقيقة', en: 'Aqeeqah' },
      { ar: 'صدقة', en: 'Charity' },
      { ar: 'نذر', en: 'Vow (Nadhr)' },
      { ar: 'فدو', en: 'Protective Sacrifice' },
    ],
  },
  {
    key: 'sacrificeFor',
    type: 'text',
    label: {
      ar: 'اسم الشخص المؤدى عنه',
      en: 'The person on whose behalf',
    },
  },
  {
    key: 'gender',
    type: 'radio',
    label: { ar: 'الجنس', en: 'Gender' },
    options: [
      { ar: 'ذكر', en: 'male' },
      { ar: 'انثى', en: 'female' },
      {
        ar: 'ذكور و اناث',
        en: 'Males and females',
      },
    ],
  },
  {
    key: 'isAlive',
    type: 'radio',
    label: { ar: 'الحالة', en: 'Status' },
    options: [
      { ar: 'حي', en: 'Alive' },
      { ar: 'متوفي', en: 'Dead' },
    ],
  },
  {
    key: 'shortDuaa',
    type: 'textarea',
    label: { ar: 'دعاء مختصر', en: 'Short Duaa' },
  },
  {
    key: 'photo',
    type: 'picture',
    label: { ar: 'صورة', en: 'Photo' },
  },
  {
    key: 'executionDate',
    type: 'date',
    label: {
      ar: '(بدون تحديد = يتم التنفيذ في اليوم التالي تلقائيا) تاريخ التنفيذ',
      en: 'Execution Date (Leave blank to schedule automatically for the next day).',
    },
  },
];

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getReservationFieldPreset(
  key: ReservationFieldKey,
): ReservationFieldConfig | undefined {
  return RESERVATION_FIELD_PRESETS.find((field) => field.key === key);
}

function findPresetByUnknownField(
  input: unknown,
): ReservationFieldConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;

  const key = (input as { key?: unknown }).key;
  if (typeof key === 'string') {
    const presetByKey = RESERVATION_FIELD_PRESETS.find(
      (field) => field.key === key,
    );
    if (presetByKey) return presetByKey;
  }

  const label = (input as { label?: { ar?: unknown; en?: unknown } }).label;
  const ar = typeof label?.ar === 'string' ? normalizeText(label.ar) : '';
  const en = typeof label?.en === 'string' ? normalizeText(label.en) : '';

  return RESERVATION_FIELD_PRESETS.find(
    (field) =>
      normalizeText(field.label.ar) === ar ||
      normalizeText(field.label.en) === en,
  );
}

export function normalizeReservationFields(
  input: unknown,
): ReservationFieldDefinition[] {
  const fields = Array.isArray(input) ? input : [];

  return RESERVATION_FIELD_PRESETS.flatMap((preset) => {
    const matched = fields.find((field) => {
      const matchedPreset = findPresetByUnknownField(field);
      return matchedPreset?.key === preset.key;
    });

    if (!matched) return [];

    const required = Boolean((matched as { required?: unknown }).required);
    const supportsMaxLength =
      preset.type === 'text' || preset.type === 'textarea';
    const rawMaxLength = (matched as { maxLength?: unknown }).maxLength;
    const maxLength =
      supportsMaxLength && typeof rawMaxLength === 'number' && rawMaxLength > 0
        ? rawMaxLength
        : supportsMaxLength && typeof rawMaxLength === 'string'
          ? Math.max(0, parseInt(rawMaxLength, 10) || 0) || undefined
          : undefined;

    return [
      {
        key: preset.key,
        type: preset.type,
        label: preset.label,
        options: preset.options,
        required,
        maxLength,
        supportsMulti: Boolean(
          (matched as { supportsMulti?: unknown }).supportsMulti,
        ),
      },
    ];
  });
}

export function findReservationInputByField(
  field: ReservationFieldDefinition,
  input: unknown,
): { value?: unknown } | undefined {
  const items = Array.isArray(input) ? input : [];

  return items.find((item) => {
    const preset = findPresetByUnknownField(item);
    return preset?.key === field.key;
  }) as { value?: unknown } | undefined;
}

export function matchReservationOption(
  field: ReservationFieldDefinition,
  value: string,
): ReservationFieldOption | undefined {
  if (!field.options?.length) return undefined;
  const normalizedValue = normalizeText(value);

  if (field.key === 'isAlive') {
    if (
      normalizedValue === 'dead' ||
      normalizedValue === 'deceased' ||
      normalizedValue === 'ميت' ||
      normalizedValue === 'متوفي'
    ) {
      return field.options.find(
        (option) => normalizeText(option.ar) === 'متوفي',
      );
    }
  }

  if (field.key === 'gender') {
    if (
      normalizedValue === 'males and females' ||
      normalizedValue === 'ذكور و اناث' ||
      normalizedValue === 'مذكر ومؤنث (أكثر من اسم واحد)'
    ) {
      return field.options.find(
        (option) => normalizeText(option.ar) === 'ذكور و اناث',
      );
    }
  }

  return field.options.find(
    (option) =>
      normalizeText(option.ar) === normalizedValue ||
      normalizeText(option.en) === normalizedValue,
  );
}
