export interface Photo {
  id: string;
  filename: string;
  location: string;
  tUtc: string;
  timeSource: 'gps' | 'exif-offset';
  lat: number;
  lon: number;
  alt?: number;
  width?: number;
  height?: number;
  orientation?: number;
  make?: string;
  model?: string;
  thumbUrl?: string;
  previewUrl?: string;
}

export interface Manifest {
  version: 1;
  generatedAt: string;
  photoCount: number;
  photos: Photo[];
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  timespan: { start: string; end: string } | null;
  skipped: { filename: string; reason: string; detail?: string }[];
}

/** Time-ordered photo with its instant precomputed, since we sort and seek constantly. */
export interface TripPhoto extends Photo {
  t: number;
  index: number;
}
