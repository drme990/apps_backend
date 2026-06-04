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
      target: 'ghadaq' | 'manasik' | 'both';
      language: 'ar' | 'en' | 'shared';
      link: string;
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
    target: 'ghadaq' | 'manasik' | 'both';
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
          target?: unknown;
          language?: unknown;
          link?: unknown;
        };

        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const imageUrl =
          typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
        const target =
          raw.target === 'ghadaq' ||
          raw.target === 'manasik' ||
          raw.target === 'both'
            ? raw.target
            : 'both';
        const language =
          raw.language === 'ar' ||
          raw.language === 'en' ||
          raw.language === 'shared'
            ? raw.language
            : 'shared';
        const link = typeof raw.link === 'string' ? raw.link.trim() : '';

        if (!id || !imageUrl) return null;

        return { id, imageUrl, target, language, link };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          imageUrl: string;
          target: 'ghadaq' | 'manasik' | 'both';
          language: 'ar' | 'en' | 'shared';
          link: string;
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
    } | null;

    const sharedAppearance =
      project !== 'shared'
        ? ((await Appearance.findOne({ project: 'shared' })
            .select({ productsBanners: 1 })
            .lean()) as { productsBanners?: unknown } | null)
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
            (banner) => banner.target === 'both' || banner.target === project,
          );

    return NextResponse.json({
      success: true,
      data: {
        worksImages,
        audioReviews: appearance.audioReviews ?? [],
        whatsAppDefaultMessage: appearance.whatsAppDefaultMessage?.trim() || '',
        bannerText: normalizeBannerText(appearance.bannerText),
        documentationAnswer: normalizeBannerText(
          appearance.documentationAnswer,
        ),
        productsBanners,
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
      },
    });
  }
}
