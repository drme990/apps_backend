import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Appearance from '@/lib/models/Appearance';

export async function GET(request: NextRequest) {
  const EMPTY = {
    worksImages: { row1: [] as string[], row2: [] as string[] },
    audioReviews: [] as unknown[],
    whatsAppDefaultMessage: '',
    bannerText: { ar: '', en: '' },
    documentationAnswer: { ar: '', en: '' },
    productsBanners: [] as Array<{
      id: string;
      imageUrl: string;
      platform: 'ghadaq' | 'manasik' | 'shared';
      language: 'ar' | 'en' | 'shared';
      link: string;
    }>,
    faqs: [] as Array<{
      id: string;
      question: { ar: string; en: string };
      answer: { ar: string; en: string };
      platform: 'ghadaq' | 'manasik' | 'shared';
      showOnProductDetails: boolean;
    }>,
  };

  const normalizeBannerText = (value: unknown): { ar: string; en: string } => {
    if (typeof value === 'string') {
      const text = value.trim();
      return { ar: text, en: text };
    }

    const raw = value as { ar?: unknown; en?: unknown } | undefined;
    return {
      ar: typeof raw?.ar === 'string' ? raw.ar.trim() : '',
      en: typeof raw?.en === 'string' ? raw.en.trim() : '',
    };
  };

  const normalizeProductsBanners = (
    value: unknown,
  ): Array<{
    id: string;
    imageUrl: string;
    platform: 'ghadaq' | 'manasik' | 'shared';
    language: 'ar' | 'en' | 'shared';
    link: string;
  }> => {
    if (!Array.isArray(value)) return [];

    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const raw = item as {
          id?: unknown;
          imageUrl?: unknown;
          platform?: unknown;
          target?: unknown; // For migration support
          language?: unknown;
          link?: unknown;
        };

        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const imageUrl =
          typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
        // Support both platform and target for migration
        const platformValue = raw.platform || raw.target;
        const platform =
          platformValue === 'ghadaq' ||
          platformValue === 'manasik' ||
          platformValue === 'shared' ||
          platformValue === 'both'
            ? platformValue === 'both'
              ? 'shared'
              : platformValue
            : 'shared';
        const language =
          raw.language === 'ar' ||
          raw.language === 'en' ||
          raw.language === 'shared'
            ? raw.language
            : 'shared';
        const link = typeof raw.link === 'string' ? raw.link.trim() : '';

        if (!id || !imageUrl) return null;

        return { id, imageUrl, platform, language, link };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          imageUrl: string;
          platform: 'ghadaq' | 'manasik' | 'shared';
          language: 'ar' | 'en' | 'shared';
          link: string;
        } => Boolean(item),
      );
  };

  const normalizeFAQs = (
    value: unknown,
  ): Array<{
    id: string;
    question: { ar: string; en: string };
    answer: { ar: string; en: string };
    platform: 'ghadaq' | 'manasik' | 'shared';
    showOnProductDetails: boolean;
  }> => {
    if (!Array.isArray(value)) return [];

    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const raw = item as {
          id?: unknown;
          question?: unknown;
          answer?: unknown;
          platform?: unknown;
          showOnProductDetails?: unknown;
        };

        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const question =
          typeof raw.question === 'object' && raw.question !== null
            ? {
                ar:
                  typeof (raw.question as { ar?: unknown }).ar === 'string'
                    ? (raw.question as { ar: string }).ar.trim()
                    : '',
                en:
                  typeof (raw.question as { en?: unknown }).en === 'string'
                    ? (raw.question as { en: string }).en.trim()
                    : '',
              }
            : { ar: '', en: '' };
        const answer =
          typeof raw.answer === 'object' && raw.answer !== null
            ? {
                ar:
                  typeof (raw.answer as { ar?: unknown }).ar === 'string'
                    ? (raw.answer as { ar: string }).ar.trim()
                    : '',
                en:
                  typeof (raw.answer as { en?: unknown }).en === 'string'
                    ? (raw.answer as { en: string }).en.trim()
                    : '',
              }
            : { ar: '', en: '' };
        const platform =
          raw.platform === 'ghadaq' ||
          raw.platform === 'manasik' ||
          raw.platform === 'shared'
            ? raw.platform
            : 'shared';
        const showOnProductDetails =
          typeof raw.showOnProductDetails === 'boolean'
            ? raw.showOnProductDetails
            : false;

        if (!id || !question.ar || !question.en || !answer.ar || !answer.en)
          return null;

        return { id, question, answer, platform, showOnProductDetails };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          question: { ar: string; en: string };
          answer: { ar: string; en: string };
          platform: 'ghadaq' | 'manasik' | 'shared';
          showOnProductDetails: boolean;
        } => Boolean(item),
      );
  };

  try {
    await connectDB();
    const project = request.nextUrl.searchParams.get('project') || 'manasik';
    const appearance = (await Appearance.findOne({ project }).lean()) as {
      worksImages?: { row1: string[]; row2: string[] };
      audioReviews?: unknown[];
      whatsAppDefaultMessage?: string;
      bannerText?: unknown;
      documentationAnswer?: unknown;
      productsBanners?: unknown;
      faqs?: unknown;
    } | null;

    const sharedAppearance =
      project !== 'shared'
        ? ((await Appearance.findOne({ project: 'shared' })
            .select({
              productsBanners: 1,
              faqs: 1,
              audioReviews: 1,
              documentationAnswer: 1,
            })
            .lean()) as {
            productsBanners?: unknown;
            faqs?: unknown;
            audioReviews?: unknown[];
            documentationAnswer?: unknown;
          } | null)
        : null;

    if (!appearance) {
      return NextResponse.json({
        success: true,
        data: {
          ...EMPTY,
          row1: EMPTY.worksImages.row1,
          row2: EMPTY.worksImages.row2,
        },
      });
    }

    const worksImages = {
      row1: appearance.worksImages?.row1 ?? [],
      row2: appearance.worksImages?.row2 ?? [],
    };

    const ownProductsBanners = normalizeProductsBanners(
      appearance.productsBanners,
    );
    const sharedProductsBanners = normalizeProductsBanners(
      sharedAppearance?.productsBanners,
    );

    const sourceProductsBanners =
      project === 'shared'
        ? ownProductsBanners
        : sharedProductsBanners.length > 0
          ? sharedProductsBanners
          : ownProductsBanners;

    const productsBanners =
      project === 'shared'
        ? sourceProductsBanners
        : sourceProductsBanners.filter(
            (banner) =>
              banner.platform === 'shared' || banner.platform === project,
          );

    const ownFAQs = normalizeFAQs(appearance.faqs);
    const sharedFAQs = normalizeFAQs(sharedAppearance?.faqs);

    const sourceFAQs =
      project === 'shared'
        ? ownFAQs
        : sharedFAQs.length > 0
          ? sharedFAQs
          : ownFAQs;

    const faqs = sourceFAQs.filter(
      (faq) => faq.platform === 'shared' || faq.platform === project,
    );

    // Merge audio reviews
    const projectAudio =
      appearance.audioReviews && Array.isArray(appearance.audioReviews)
        ? appearance.audioReviews
        : [];
    const sharedAudio =
      sharedAppearance?.audioReviews &&
      Array.isArray(sharedAppearance.audioReviews)
        ? sharedAppearance.audioReviews
        : [];
    const allAudio = [...projectAudio, ...sharedAudio];
    const audioReviews =
      project === 'shared'
        ? allAudio
        : allAudio.filter(
            (item: any) =>
              item && (item.platform === project || item.platform === 'shared'),
          );

    // Get documentation answer
    const sourceDocumentationAnswer =
      project === 'shared'
        ? appearance.documentationAnswer
        : (sharedAppearance?.documentationAnswer ??
          appearance.documentationAnswer);
    const documentationAnswer = normalizeBannerText(sourceDocumentationAnswer);

    return NextResponse.json({
      success: true,
      data: {
        worksImages,
        audioReviews,
        whatsAppDefaultMessage: appearance.whatsAppDefaultMessage?.trim() || '',
        bannerText: normalizeBannerText(appearance.bannerText),
        documentationAnswer,
        productsBanners,
        faqs,
        // Keep backward compatibility for existing consumers.
        row1: worksImages.row1,
        row2: worksImages.row2,
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        ...EMPTY,
        row1: EMPTY.worksImages.row1,
        row2: EMPTY.worksImages.row2,
        faqs: [],
      },
    });
  }
}
