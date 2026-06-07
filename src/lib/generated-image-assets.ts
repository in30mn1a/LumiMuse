export type GeneratedImageVersion = {
  id: string;
  url: string;
  prompt: string;
};

export type GeneratedImage = {
  id: string;
  url?: string;
  prompt: string;
  status?: 'pending_prompt' | 'pending_image' | 'failed' | 'ready';
  error?: string;
  versions?: Array<GeneratedImageVersion>;
  activeVersion?: number;
};

export type GeneratedImageRow = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  metadata: unknown;
};

export type GeneratedImageReference = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  imageId: string;
  versionId: string;
};

export type UniqueGeneratedImageItem = GeneratedImageReference & {
  url: string;
  prompt: string;
  referenceCount: number;
  references: Array<GeneratedImageReference>;
};

type RemoveTarget = {
  urls?: Set<string>;
  imageId?: string;
  versionId?: string;
};

const GENERATED_IMAGE_STATUSES = new Set(['pending_prompt', 'pending_image', 'failed', 'ready']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeGeneratedImageVersion(value: unknown): GeneratedImageVersion | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string') return null;
  if (typeof value.url !== 'string') return null;
  if (typeof value.prompt !== 'string') return null;
  return {
    id: value.id,
    url: value.url,
    prompt: value.prompt,
  };
}

export function sanitizeGeneratedImages(value: unknown): Array<GeneratedImage> {
  if (!Array.isArray(value)) return [];

  const images: Array<GeneratedImage> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== 'string') continue;
    if (typeof item.prompt !== 'string') continue;

    const image: GeneratedImage = {
      id: item.id,
      prompt: item.prompt,
    };
    if (typeof item.url === 'string') image.url = item.url;
    if (typeof item.status === 'string' && GENERATED_IMAGE_STATUSES.has(item.status)) {
      image.status = item.status as GeneratedImage['status'];
    }
    if (typeof item.error === 'string') image.error = item.error;
    if (Array.isArray(item.versions)) {
      const versions = item.versions
        .map(sanitizeGeneratedImageVersion)
        .filter((version): version is GeneratedImageVersion => version !== null);
      if (versions.length > 0) image.versions = versions;
    }
    if (typeof item.activeVersion === 'number' && Number.isInteger(item.activeVersion) && item.activeVersion >= 0) {
      image.activeVersion = item.activeVersion;
    }

    if (!image.url && image.versions && image.versions.length > 0) {
      const activeVersion = typeof image.activeVersion === 'number' && image.activeVersion < image.versions.length
        ? image.activeVersion
        : 0;
      image.url = image.versions[activeVersion].url;
      image.prompt = image.versions[activeVersion].prompt;
      image.activeVersion = activeVersion;
    }
    if (!image.url && image.status !== 'pending_prompt' && image.status !== 'pending_image' && image.status !== 'failed') {
      continue;
    }

    images.push(image);
  }
  return images;
}

export function normalizeGeneratedImageVersions(image: GeneratedImage): Array<GeneratedImageVersion> {
  if (Array.isArray(image.versions) && image.versions.length > 0) {
    return image.versions.filter(version => version.url);
  }

  return image.url
    ? [{ id: image.id, url: image.url, prompt: image.prompt }]
    : [];
}

function getActiveVersionIndex(image: GeneratedImage, versions: Array<GeneratedImageVersion>): number {
  if (typeof image.activeVersion === 'number' && image.activeVersion >= 0 && image.activeVersion < versions.length) {
    return image.activeVersion;
  }
  const matchedIndex = versions.findIndex(version => version.id === image.id || version.url === image.url);
  return matchedIndex >= 0 ? matchedIndex : 0;
}

function shouldRemoveVersion(
  image: GeneratedImage,
  version: GeneratedImageVersion,
  versionIndex: number,
  activeVersion: number,
  target: RemoveTarget,
): boolean {
  if (target.urls?.has(version.url)) return true;
  if (target.imageId !== image.id) return false;
  if (target.versionId) return target.versionId === version.id;
  return versionIndex === activeVersion;
}

export function collectUniqueGeneratedImageItems(rows: Array<GeneratedImageRow>): Array<UniqueGeneratedImageItem> {
  const byUrl = new Map<string, UniqueGeneratedImageItem>();

  for (const row of rows) {
    const meta = parseMetadata(row.metadata);
    const generatedImages = sanitizeGeneratedImages(meta.generatedImages);

    for (const image of generatedImages) {
      const versions = normalizeGeneratedImageVersions(image);
      for (const version of versions) {
        const reference: GeneratedImageReference = {
          messageId: row.messageId,
          conversationId: row.conversationId,
          conversationTitle: row.conversationTitle,
          createdAt: row.createdAt,
          imageId: image.id,
          versionId: version.id,
        };

        const existing = byUrl.get(version.url);
        if (existing) {
          existing.references.push(reference);
          existing.referenceCount = existing.references.length;
          continue;
        }

        byUrl.set(version.url, {
          ...reference,
          url: version.url,
          prompt: version.prompt,
          referenceCount: 1,
          references: [reference],
        });
      }
    }
  }

  return [...byUrl.values()];
}

export function removeGeneratedImageReferences(
  metadata: unknown,
  target: RemoveTarget,
): { metadata: Record<string, unknown>; removedUrls: string[]; changed: boolean } {
  const meta = parseMetadata(metadata);
  const generatedImages = sanitizeGeneratedImages(meta.generatedImages);
  const removedUrls = new Set<string>();
  let changed = false;

  const nextImages = generatedImages.flatMap(image => {
    const versions = normalizeGeneratedImageVersions(image);
    if (versions.length === 0) return [image];

    const activeVersion = getActiveVersionIndex(image, versions);
    const activeVersionId = versions[activeVersion]?.id;
    const remainingVersions = versions.filter((version, index) => {
      const remove = shouldRemoveVersion(image, version, index, activeVersion, target);
      if (remove) {
        removedUrls.add(version.url);
        changed = true;
      }
      return !remove;
    });

    if (remainingVersions.length === versions.length) return [image];
    if (remainingVersions.length === 0) return [];

    const keptActiveIndex = remainingVersions.findIndex(version => version.id === activeVersionId);
    const nextActiveVersion = keptActiveIndex >= 0
      ? keptActiveIndex
      : Math.min(activeVersion, remainingVersions.length - 1);
    const current = remainingVersions[nextActiveVersion];

    return [{
      ...image,
      url: current.url,
      prompt: current.prompt,
      versions: remainingVersions,
      activeVersion: nextActiveVersion,
    }];
  });

  if (changed) {
    if (nextImages.length > 0) {
      meta.generatedImages = nextImages;
    } else {
      delete meta.generatedImages;
    }
  }

  return {
    metadata: meta,
    removedUrls: [...removedUrls],
    changed,
  };
}
