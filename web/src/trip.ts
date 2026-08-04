import type { Manifest, TripPhoto } from './types';

export interface Trip {
  photos: TripPhoto[];
  start: number;
  end: number;
  bounds: [[number, number], [number, number]];
  /** Day boundaries in local time, for the timeline's date ticks. */
  days: { label: string; t: number; count: number }[];
  distanceKm: number;
}

export async function loadTrip(url = 'trip.json'): Promise<Trip> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const manifest = (await res.json()) as Manifest;
  return buildTrip(manifest);
}

export function buildTrip(manifest: Manifest): Trip {
  const photos: TripPhoto[] = manifest.photos
    .map((p) => ({ ...p, t: Date.parse(p.tUtc), index: 0 }))
    .sort((a, b) => a.t - b.t)
    .map((p, index) => ({ ...p, index }));

  if (photos.length === 0) throw new Error('This trip has no mapped photos yet.');

  const start = photos[0].t;
  const end = photos[photos.length - 1].t;

  const b = manifest.bounds ?? {
    minLat: Math.min(...photos.map((p) => p.lat)),
    maxLat: Math.max(...photos.map((p) => p.lat)),
    minLon: Math.min(...photos.map((p) => p.lon)),
    maxLon: Math.max(...photos.map((p) => p.lon)),
  };

  const byDay = new Map<string, { t: number; count: number }>();
  for (const p of photos) {
    const key = new Date(p.t).toISOString().slice(0, 10);
    const entry = byDay.get(key);
    if (entry) entry.count++;
    else byDay.set(key, { t: p.t, count: 1 });
  }

  return {
    photos,
    start,
    end,
    bounds: [
      [b.minLon, b.minLat],
      [b.maxLon, b.maxLat],
    ],
    days: [...byDay.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b2) => a.t - b2.t),
    distanceKm: totalDistanceKm(photos),
  };
}

/** Great-circle distance, summed along the photo order. */
export function totalDistanceKm(photos: TripPhoto[]): number {
  let sum = 0;
  for (let i = 1; i < photos.length; i++) sum += haversineKm(photos[i - 1], photos[i]);
  return sum;
}

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Index of the last photo at or before `t`; -1 before the trip starts. */
export function photoIndexAt(photos: TripPhoto[], t: number): number {
  let lo = 0;
  let hi = photos.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (photos[mid].t <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Below this, a leg is ordinary movement and never worth flagging. */
const MIN_FLAGGED_KM = 60;

/**
 * Above this implied speed, the gap cannot have been travelled on the ground.
 * Motorway driving averages well under 120 km/h door to door, so 200 leaves
 * generous headroom before we call something a flight.
 */
const IMPLAUSIBLE_KMH = 200;

/**
 * Should the leg between two photos be drawn dashed?
 *
 * Distance alone is the wrong test: on a road trip, consecutive photos are
 * routinely a few hundred kilometres apart simply because nobody photographed
 * the motorway, and dashing those makes the entire route look like guesswork.
 * What actually indicates an unrecorded hop is *implied speed* — covering the
 * distance faster than any ground transport could.
 */
export function isImplausibleLeg(
  a: { lat: number; lon: number; t: number },
  b: { lat: number; lon: number; t: number },
): boolean {
  const km = haversineKm(a, b);
  if (km < MIN_FLAGGED_KM) return false;
  const hours = Math.abs(b.t - a.t) / 3_600_000;
  if (hours <= 0) return true;
  return km / hours > IMPLAUSIBLE_KMH;
}

export function formatDay(t: number): string {
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

export function formatDayTime(t: number): string {
  return `${formatDay(t)} · ${formatTime(t)}`;
}
