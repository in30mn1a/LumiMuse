export type GeneratedImageVersion = {
  id: string;
  url: string;
  prompt: string;
};

export type GeneratedImage = {
  id: string;
  url?: string;
  prompt: string;
  status?: string;
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

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return (value as Record<string, unknown>) || {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    const generatedImages = (meta.generatedImages as Array<GeneratedImage> | undefined) || [];

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
  const generatedImages = (meta.generatedImages as Array<GeneratedImage> | undefined) || [];
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
