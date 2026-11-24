import counties from './counties.ts';

export const roadwayLayer = 'https://services2.arcgis.com/nf3p7v7Zy4fTOh6M/ArcGIS/rest/services/TDOT_Roadway_Network/FeatureServer/0';
export const sourceLabel = 'TDOT County Log Network';
export type Fix = { latitude: number; longitude: number; accuracy: number | null; heading: number | null; speed: number | null; timestamp: number };
export type Match = { route: string; county: string; mile: number; distance: number; routeId: string };
type Feature = {
  attributes: { ROUTE_ID: string; ROUTE_TYPE: string; ROUTE_NUMBER: string; COUNTY_NUMBER: string };
  geometry?: { paths: number[][][] };
};
export type Lookup = { kind: 'matched'; match: Match } | { kind: 'review'; message: string; candidates?: Match[] };

export function matchRoad(fix: Fix, features: Feature[]): Lookup {
  if (fix.accuracy == null || fix.accuracy < 0 || fix.accuracy > 35) {
    return { kind: 'review', message: 'Low GPS accuracy. Enter the location manually.' };
  }
  const horizontal = 111_320 * Math.cos(fix.latitude * Math.PI / 180);
  const hits = new Map<string, Match>();
  for (const { attributes, geometry } of features) {
    const { ROUTE_TYPE, ROUTE_NUMBER, COUNTY_NUMBER, ROUTE_ID } = attributes;
    const county = counties[COUNTY_NUMBER as keyof typeof counties];
    if (!county || !/^\d+$/.test(ROUTE_NUMBER) || !['I', 'S'].includes(ROUTE_TYPE)) continue;
    const route = ROUTE_TYPE === 'I' ? `I-${Number(ROUTE_NUMBER)}` : `SR ${Number(ROUTE_NUMBER)}`;
    const key = ROUTE_ID.slice(0, -6);
    for (const path of geometry?.paths ?? []) {
      for (let i = 1; i < path.length; i++) {
        const [ax, ay, am] = path[i - 1];
        const [bx, by, bm] = path[i];
        if (![ax, ay, am, bx, by, bm].every(Number.isFinite) || am < 0 || bm < 0) continue;
        const x = (ax - fix.longitude) * horizontal;
        const y = (ay - fix.latitude) * 111_320;
        const dx = (bx - ax) * horizontal;
        const dy = (by - ay) * 111_320;
        const length = dx * dx + dy * dy;
        if (!length) continue;
        const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / length));
        const distance = Math.hypot(x + t * dx, y + t * dy);
        const mile = Math.round((am + t * (bm - am)) * 100) / 100;
        if (distance < (hits.get(key)?.distance ?? Infinity)) {
          hits.set(key, { route, county: `${county} County`, mile, distance, routeId: ROUTE_ID });
        }
      }
    }
  }
  const ordered = [...hits.values()].sort((a, b) => a.distance - b.distance);
  const [closest, next] = ordered;
  if (!closest || closest.distance > 100) return { kind: 'review', message: 'No TDOT mainline within 100 m. Enter the location manually.' };
  if (next && next.distance - closest.distance < Math.max(15, fix.accuracy)) {
    return { kind: 'review', message: 'Multiple nearby routes. Choose a route or enter it manually.', candidates: ordered.filter(x => x.distance <= 100).slice(0, 4) };
  }
  return { kind: 'matched', match: closest };
}

export async function lookupRoad(fix: Fix): Promise<Lookup> {
  if (fix.accuracy == null || fix.accuracy < 0 || fix.accuracy > 35) return matchRoad(fix, []);
  const lat = fix.latitude;
  const lon = fix.longitude;
  const dx = 0.003 / Math.cos(lat * Math.PI / 180);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const query = new URLSearchParams({
      f: 'json', where: "TO_DATE IS NULL AND RAMP_ID = '00000'",
      geometry: `${lon - dx},${lat - 0.003},${lon + dx},${lat + 0.003}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      outFields: 'ROUTE_ID,ROUTE_TYPE,ROUTE_NUMBER,COUNTY_NUMBER',
      returnM: 'true', returnZ: 'false',
    });
    const response = await fetch(`${roadwayLayer}/query?${query}`, { signal: controller.signal });
    if (!response.ok) throw Error('Request failed');
    const data = await response.json();
    if (data.hasM !== true || !Array.isArray(data.features) || data.error || data.exceededTransferLimit) throw Error('Incomplete route data');
    return matchRoad(fix, data.features);
  } catch {
    return { kind: 'review', message: 'TDOT lookup unavailable. Enter the location manually.' };
  } finally {
    clearTimeout(timer);
  }
}
