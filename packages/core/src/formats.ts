/**
 * The newest version of each stored format this code reads. Each reader reads every version up to
 * its number, and a writer writes the lowest version that can hold what it stores, so readers
 * that are behind still open everything that does not need the newer format. docs/VERSIONING.md
 * lists what each version means; a version is taken there before it is written anywhere.
 */
export const FORMATS = {
  /** `v` of a `site` document. */
  site: 1,
  /** `v` of a `chunk` document. */
  chunk: 1,
  /** `N` in a `dash-manifest:vN:` content URI. */
  contentUri: 1,
  /** `v` of a manifest. */
  manifest: 2,
} as const;

export type FormatName = keyof typeof FORMATS;

/** A stored object is in a format newer than this code reads. Newer code may read it. */
export class NewerFormatError extends Error {
  constructor(
    readonly format: FormatName,
    readonly version: number,
  ) {
    super(`${format} format ${version} is newer than this version reads (up to ${FORMATS[format]})`);
    this.name = 'NewerFormatError';
  }
}

/** The version a document stores in `v`. Documents from before the field existed are version 1. */
export function formatVersion(value: unknown): number {
  return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 1;
}

/** Throws {@link NewerFormatError} when `version` is newer than this code reads. */
export function refuseNewer(format: FormatName, version: unknown): void {
  if (isNewer(format, version)) throw new NewerFormatError(format, version);
}

/** Whether `version` is a format version that is newer than this code reads. */
export const isNewer = (format: FormatName, version: unknown): version is number => Number.isSafeInteger(version) && (version as number) > FORMATS[format];
