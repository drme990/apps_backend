/**
 * Audio Main Logic - Shared across all apps
 *
 * Rules:
 * 1. A main on platform 'shared' is global and exclusive:
 *    - Only one global shared main can exist.
 *    - It cannot coexist with mains on 'ghadaq' or 'manasik'.
 * 2. For each specific platform ('ghadaq' or 'manasik'):
 *    - You may set one main for 'en' and one main for 'ar' at the same time.
 *    - OR one main for language 'shared'.
 *    - Platform-language 'shared' cannot coexist with 'en' or 'ar' mains on that same platform.
 *
 * Returns: Updated audio reviews array with isMain flags adjusted according to rules
 */

export type ProjectPlatform = 'ghadaq' | 'manasik' | 'shared';
export type AudioLanguage = 'ar' | 'en' | 'shared';

export interface AudioReviewInput {
  id: string;
  url: string;
  nameAr: string;
  nameEn: string;
  userImage: string;
  platform: ProjectPlatform;
  language: AudioLanguage;
  isMain: boolean;
}

function findMain(
  audioReviews: AudioReviewInput[],
  predicate: (audio: AudioReviewInput) => boolean,
): AudioReviewInput | undefined {
  return audioReviews.find((audio) => audio.isMain && predicate(audio));
}

/**
 * Calculate which audio should be main for a given platform and language
 */
export function getMainAudioForPlatformLang(
  audioReviews: AudioReviewInput[],
  targetPlatform: ProjectPlatform,
  targetLang: AudioLanguage,
): AudioReviewInput | undefined {
  if (targetPlatform === 'shared') {
    return (
      findMain(
        audioReviews,
        (audio) => audio.platform === 'shared' && audio.language === targetLang,
      ) ||
      findMain(
        audioReviews,
        (audio) => audio.platform === 'shared' && audio.language === 'shared',
      )
    );
  }

  return (
    findMain(
      audioReviews,
      (audio) =>
        audio.platform === targetPlatform && audio.language === targetLang,
    ) ||
    findMain(
      audioReviews,
      (audio) =>
        audio.platform === targetPlatform && audio.language === 'shared',
    ) ||
    findMain(
      audioReviews,
      (audio) => audio.platform === 'shared' && audio.language === targetLang,
    ) ||
    findMain(
      audioReviews,
      (audio) => audio.platform === 'shared' && audio.language === 'shared',
    )
  );
}

/**
 * Set an audio as main while enforcing the rules
 * Returns updated array with isMain flags adjusted
 */
export function setAudioAsMain(
  audioReviews: AudioReviewInput[],
  targetId: string,
): AudioReviewInput[] {
  const targetAudio = audioReviews.find((a) => a.id === targetId);
  if (!targetAudio) return audioReviews;

  const newIsMain = !targetAudio.isMain;

  if (!newIsMain) {
    return audioReviews.map((audio) =>
      audio.id === targetId ? { ...audio, isMain: false } : audio,
    );
  }

  return audioReviews.map((audio) => {
    if (audio.id === targetId) {
      return { ...audio, isMain: true };
    }

    if (!audio.isMain) {
      return audio;
    }

    if (targetAudio.platform === 'shared') {
      return { ...audio, isMain: false };
    }

    if (audio.platform === 'shared') {
      return { ...audio, isMain: false };
    }

    if (audio.platform !== targetAudio.platform) {
      return audio;
    }

    if (targetAudio.language === 'shared') {
      return { ...audio, isMain: false };
    }

    if (
      audio.language === 'shared' ||
      audio.language === targetAudio.language
    ) {
      return { ...audio, isMain: false };
    }

    return audio;
  });
}

/**
 * Validate the audio reviews array and fix any violations
 * Call this when loading data from backend
 */
export function validateAudioMains(
  audioReviews: AudioReviewInput[],
): AudioReviewInput[] {
  const mains = audioReviews.filter((audio) => audio.isMain);
  if (mains.length === 0) return audioReviews;

  const mainsToKeep = new Set<string>();

  const globalSharedMain = mains.find((audio) => audio.platform === 'shared');
  if (globalSharedMain) {
    mainsToKeep.add(globalSharedMain.id);
  } else {
    const platforms: Array<Exclude<ProjectPlatform, 'shared'>> = [
      'ghadaq',
      'manasik',
    ];

    for (const platform of platforms) {
      const platformMains = mains.filter(
        (audio) => audio.platform === platform,
      );
      if (platformMains.length === 0) continue;

      const platformSharedMain = platformMains.find(
        (audio) => audio.language === 'shared',
      );

      if (platformSharedMain) {
        mainsToKeep.add(platformSharedMain.id);
        continue;
      }

      const enMain = platformMains.find((audio) => audio.language === 'en');
      const arMain = platformMains.find((audio) => audio.language === 'ar');

      if (enMain) mainsToKeep.add(enMain.id);
      if (arMain) mainsToKeep.add(arMain.id);
    }
  }

  return audioReviews.map((audio) => ({
    ...audio,
    isMain: mainsToKeep.has(audio.id),
  }));
}

/**
 * Get the main audio for current platform and language context
 * Used by frontend apps to determine which audio to play first
 */
export function getMainAudioForContext(
  audioReviews: AudioReviewInput[],
  currentPlatform: 'ghadaq' | 'manasik',
  currentLocale: 'ar' | 'en',
): AudioReviewInput | undefined {
  return getMainAudioForPlatformLang(
    audioReviews,
    currentPlatform,
    currentLocale,
  );
}

/**
 * Order audio reviews: main audio first, then shuffle others
 */
export function orderAudioReviews(
  audioReviews: AudioReviewInput[],
  currentPlatform: 'ghadaq' | 'manasik',
  currentLocale: 'ar' | 'en',
): AudioReviewInput[] {
  const mainAudio = getMainAudioForContext(
    audioReviews,
    currentPlatform,
    currentLocale,
  );

  if (!mainAudio) {
    // No main audio, shuffle all
    return shuffleArray([...audioReviews]);
  }

  const others = audioReviews.filter((a) => a.id !== mainAudio.id);
  const shuffledOthers = shuffleArray(others);

  return [mainAudio, ...shuffledOthers];
}

function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
