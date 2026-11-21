const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
};

const ALREADY_COMPRESSED = /^(image\/(png|jpeg|gif|webp|avif)|font\/woff2?|audio\/|video\/|application\/(zip|pdf))/;

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

export function isCompressible(type: string): boolean {
  return !ALREADY_COMPRESSED.test(type);
}
