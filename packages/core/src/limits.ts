/** Bytes one chunk document holds: three fields of 4,900. */
export const CHUNK_FIELD_SIZE = 4900;
export const CHUNK_FIELDS = 3;
export const CHUNK_SIZE = CHUNK_FIELD_SIZE * CHUNK_FIELDS;

/** Chunks a reader asks for together with the site record, in the one query that resolves a name. */
export const PRELOAD_CHUNKS = 32;

export const MAX_CONTENT_URI_LENGTH = 2048;
/** `dash-manifest:v1:` plus 30 hashes and commas fits the content field. */
export const MAX_MANIFEST_CHUNKS = 30;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 5000;
export const MAX_PATH_BYTES = 512;
export const MAX_SITE_BYTES = 50 * 1024 * 1024;
export const MAX_SITE_CHUNKS = Math.ceil(MAX_SITE_BYTES / CHUNK_SIZE) + MAX_FILES;
export const MAX_TYPE_LENGTH = 128;
/** A file stored outside Platform is read whole before any of it is served, so its size is capped. */
export const MAX_ELSEWHERE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PLACES = 8;
export const MAX_PLACE_LENGTH = 2048;

export interface Limits {
  maxSiteBytes: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: Limits = { maxSiteBytes: MAX_SITE_BYTES, maxFiles: MAX_FILES };
