export type Coords = readonly [lat: number, lon: number];

export interface NodeGeo {
  /** Dominant 1-degree coordinate per IPv4 `/16` prefix (`"a.b"`). */
  p16: Record<string, Coords>;
  /** Per-IPv4 overrides where a host differs from its `/16` majority. */
  ip: Record<string, Coords>;
}

/**
 * Coarse 1-degree coordinates for AWS CloudFront edge PoP IATA codes (`x-amz-cf-pop`).
 * Covers global PoPs across North America, South America, Europe, Middle East, Africa, Asia, and Oceania.
 */
const POP_COORDS: Record<string, Coords> = {
  // North America
  ATL: [34, -84],
  BOS: [42, -71],
  CMH: [40, -83],
  DEN: [40, -105],
  DFW: [33, -97],
  DTW: [42, -83],
  EWR: [41, -74],
  HIO: [46, -123],
  HOU: [30, -95],
  IAD: [39, -77],
  IAH: [30, -95],
  IND: [40, -86],
  JAX: [30, -82],
  JFK: [41, -74],
  LAS: [36, -115],
  LAX: [34, -118],
  MCI: [39, -95],
  MEX: [19, -99],
  MIA: [26, -80],
  MSP: [45, -93],
  ORD: [42, -88],
  PDX: [46, -123],
  PHL: [40, -75],
  PHX: [33, -112],
  PIT: [40, -80],
  QRO: [21, -100],
  SEA: [47, -122],
  SFO: [38, -122],
  SJC: [37, -122],
  SLC: [41, -112],
  TPA: [28, -82],
  YMQ: [45, -74],
  YTO: [44, -79],
  YUL: [45, -74],
  YVR: [49, -123],
  YYZ: [44, -79],
  // South America
  BOG: [5, -74],
  EZE: [-35, -58],
  FOR: [-4, -39],
  GIG: [-23, -43],
  GRU: [-24, -47],
  LIM: [-12, -77],
  SCL: [-33, -71],
  // Europe
  AMS: [52, 5],
  ARN: [59, 18],
  ATH: [38, 24],
  BER: [53, 13],
  BRU: [51, 4],
  BUD: [47, 19],
  CDG: [49, 2],
  CPH: [56, 13],
  DUB: [53, -6],
  DUS: [51, 7],
  FCO: [42, 12],
  FRA: [50, 9],
  GVA: [46, 6],
  HAM: [54, 10],
  HEL: [60, 25],
  LHR: [51, 0],
  LIS: [39, -9],
  MAD: [40, -4],
  MAN: [53, -2],
  MRS: [43, 5],
  MUC: [48, 12],
  MXP: [46, 9],
  OSL: [60, 11],
  OTP: [44, 26],
  PMO: [38, 13],
  PRG: [50, 14],
  SOF: [43, 23],
  TXL: [53, 13],
  VIE: [48, 16],
  WAW: [52, 21],
  ZAG: [46, 16],
  ZRH: [47, 9],
  // Middle East & Africa
  BAH: [26, 51],
  CAI: [30, 31],
  CPT: [-34, 18],
  DOH: [25, 52],
  DXB: [25, 55],
  FJR: [25, 56],
  IST: [41, 29],
  JED: [22, 39],
  JNB: [-26, 28],
  LOS: [7, 3],
  MCT: [24, 58],
  NBO: [-1, 37],
  RUH: [25, 47],
  TLV: [32, 35],
  // Asia
  BKK: [14, 101],
  BLR: [13, 78],
  BOM: [19, 73],
  CCU: [23, 88],
  CGK: [-6, 107],
  DEL: [29, 77],
  HAN: [21, 106],
  HKG: [22, 114],
  HYD: [17, 78],
  ICN: [37, 127],
  KIX: [34, 135],
  KUL: [3, 102],
  MAA: [13, 80],
  MNL: [15, 121],
  NRT: [36, 140],
  PNQ: [19, 74],
  SGN: [11, 107],
  SIN: [1, 104],
  TPE: [25, 121],
  // Oceania
  AKL: [-37, 175],
  BNE: [-27, 153],
  MEL: [-38, 145],
  PER: [-32, 116],
  SYD: [-34, 151],
};

/** Zero-network fallback when `x-amz-cf-pop` is absent. */
const TZ_COORDS: Record<string, Coords> = {
  'America/New_York': [41, -74],
  'America/Toronto': [44, -79],
  'America/Chicago': [42, -88],
  'America/Denver': [40, -105],
  'America/Phoenix': [33, -112],
  'America/Los_Angeles': [34, -118],
  'America/Vancouver': [49, -123],
  'America/Mexico_City': [19, -99],
  'America/Sao_Paulo': [-24, -47],
  'America/Argentina/Buenos_Aires': [-35, -58],
  'Europe/London': [51, 0],
  'Europe/Dublin': [53, -6],
  'Europe/Paris': [49, 2],
  'Europe/Berlin': [52, 13],
  'Europe/Amsterdam': [52, 5],
  'Europe/Madrid': [40, -4],
  'Europe/Rome': [42, 12],
  'Europe/Warsaw': [52, 21],
  'Europe/Stockholm': [59, 18],
  'Europe/Helsinki': [60, 25],
  'Europe/Zurich': [47, 9],
  'Asia/Tokyo': [36, 140],
  'Asia/Seoul': [37, 127],
  'Asia/Singapore': [1, 104],
  'Asia/Hong_Kong': [22, 114],
  'Asia/Kolkata': [22, 79],
  'Asia/Dubai': [25, 55],
  'Australia/Sydney': [-34, 151],
  'Australia/Melbourne': [-38, 145],
  'Pacific/Auckland': [-37, 175],
};

const TZ_REGION_COORDS: Record<string, Coords> = {
  America: [39, -98],
  Europe: [50, 10],
  Asia: [28, 105],
  Australia: [-32, 145],
  Pacific: [-20, 165],
  Africa: [0, 20],
};

export function visitorCoords(cfPop: string | null | undefined, timeZone?: string): Coords | undefined {
  const code = cfPop?.trim().slice(0, 3).toUpperCase();
  if (code && POP_COORDS[code]) return POP_COORDS[code];
  const tz = timeZone ?? safeTimeZone();
  if (!tz) return undefined;
  if (TZ_COORDS[tz]) return TZ_COORDS[tz];
  const region = tz.split('/')[0];
  return region ? TZ_REGION_COORDS[region] : undefined;
}

function safeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function nodeCoords(host: string, geo?: NodeGeo): Coords | undefined {
  if (!geo) return undefined;
  const ip = host.split(':')[0] ?? '';
  const exact = geo.ip[ip];
  if (exact) return exact;
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  return geo.p16[`${parts[0]}.${parts[1]}`];
}

const DEG = Math.PI / 180;
const EARTH_KM = 6371;

export function distanceKm(a: Coords, b: Coords): number {
  const dLat = (b[0] - a[0]) * DEG;
  const dLon = (b[1] - a[1]) * DEG;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * sinLon * sinLon;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface BiasOptions {
  tries?: number;
  /** Size of the closest-node pool to draw randomly from (avoids pinning every user to the same 4 nodes). */
  nearPool?: number;
  /** How many candidates come from the closest pool; the remainder are global randoms for diversity/failover. */
  nearPick?: number;
  random?: () => number;
}

/**
 * Biases probe candidates toward nodes geographically close to the visitor without hard-pinning
 * a fixed set of operators: shuffles the closest `nearPool` nodes, picks `nearPick` of them, and
 * fills the rest of `tries` uniformly from the remaining (including unknown-geo) nodes.
 */
export function selectBiasedCandidates(
  hosts: readonly string[],
  visitor: Coords | undefined,
  geo: NodeGeo | undefined,
  options: BiasOptions = {},
): string[] {
  const random = options.random ?? Math.random;
  const tries = options.tries ?? 10;
  if (!visitor || !geo || hosts.length <= tries) return shuffle([...hosts], random).slice(0, tries);

  const known: Array<{ host: string; dist: number }> = [];
  const unknown: string[] = [];
  for (const host of hosts) {
    const pt = nodeCoords(host, geo);
    if (pt) known.push({ host, dist: distanceKm(visitor, pt) });
    else unknown.push(host);
  }
  if (known.length === 0) return shuffle([...hosts], random).slice(0, tries);

  known.sort((a, b) => a.dist - b.dist);
  const nearPool = Math.max(options.nearPool ?? 24, tries);
  const nearPick = Math.min(options.nearPick ?? Math.max(tries - 2, 1), tries, known.length);

  const closeSlice = shuffle(
    known.slice(0, nearPool).map((entry) => entry.host),
    random,
  );
  const picked = closeSlice.slice(0, nearPick);
  const needMore = tries - picked.length;
  if (needMore <= 0) return picked;

  const rest = [...closeSlice.slice(nearPick), ...known.slice(nearPool).map((entry) => entry.host), ...unknown];
  return [...picked, ...shuffle(rest, random).slice(0, needMore)];
}
