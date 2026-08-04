import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { Trip } from './trip';
import { isImplausibleLeg } from './trip';
import type { TripPhoto } from './types';

const ACCENT = '#ffb340';

/**
 * Carto's Dark Matter raster tiles: no API key, no account, and the dark
 * palette lets the orange route carry the eye. Attribution is required and
 * rendered by MapLibre from the source definition below.
 */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
};

interface Props {
  trip: Trip;
  cursor: number;
  current: TripPhoto | null;
  onSelect: (photo: TripPhoto) => void;
}

/** Split the route into solid legs and long dashed jumps. */
function routeFeatures(photos: TripPhoto[]) {
  const solid: [number, number][][] = [];
  const jumps: [number, number][][] = [];
  let run: [number, number][] = photos.length ? [[photos[0].lon, photos[0].lat]] : [];

  for (let i = 1; i < photos.length; i++) {
    const prev = photos[i - 1];
    const cur = photos[i];
    const point: [number, number] = [cur.lon, cur.lat];
    if (isImplausibleLeg(prev, cur)) {
      if (run.length > 1) solid.push(run);
      jumps.push([
        [prev.lon, prev.lat],
        point,
      ]);
      run = [point];
    } else {
      run.push(point);
    }
  }
  if (run.length > 1) solid.push(run);
  return { solid, jumps };
}

function lineCollection(lines: [number, number][][]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: lines.map((coordinates) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  };
}

function pointCollection(photos: TripPhoto[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: photos.map((p) => ({
      type: 'Feature',
      properties: { index: p.index },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

export function MapView({ trip, cursor, current, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const marker = useRef<maplibregl.Marker | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Create the map once; trip data drives sources afterwards.
  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      bounds: trip.bounds,
      fitBoundsOptions: { padding: 80, maxZoom: 12 },
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    // 'style.load', not 'load': the latter waits for basemap tiles to arrive,
    // so a blocked or slow tile CDN would leave the trip itself undrawn. The
    // route is our data and must never depend on someone else's server.
    const addTripLayers = () => {
      if (m.getSource('route-full')) return;
      const full = routeFeatures(trip.photos);

      m.addSource('route-full', { type: 'geojson', data: lineCollection(full.solid) });
      m.addSource('route-jumps-full', { type: 'geojson', data: lineCollection(full.jumps) });
      m.addSource('route-done', { type: 'geojson', data: lineCollection([]) });
      m.addSource('route-jumps-done', { type: 'geojson', data: lineCollection([]) });
      m.addSource('photos', { type: 'geojson', data: pointCollection([]) });

      // The whole route sits underneath, dimmed, so the shape of the trip is
      // always legible even when the timeline is scrubbed to the first day.
      m.addLayer({
        id: 'route-full',
        type: 'line',
        source: 'route-full',
        paint: { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.18 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      m.addLayer({
        id: 'route-jumps-full',
        type: 'line',
        source: 'route-jumps-full',
        paint: {
          'line-color': ACCENT,
          'line-width': 1.5,
          'line-opacity': 0.12,
          'line-dasharray': [2, 3],
        },
      });
      m.addLayer({
        id: 'route-jumps-done',
        type: 'line',
        source: 'route-jumps-done',
        paint: {
          'line-color': ACCENT,
          'line-width': 1.5,
          'line-opacity': 0.5,
          'line-dasharray': [2, 3],
        },
      });
      m.addLayer({
        id: 'route-done',
        type: 'line',
        source: 'route-done',
        paint: { 'line-color': ACCENT, 'line-width': 3.5, 'line-opacity': 0.95 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      m.addLayer({
        id: 'photos',
        type: 'circle',
        source: 'photos',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 5.5, 14, 7],
          'circle-color': ACCENT,
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0a0a0a',
        },
      });

      m.on('click', 'photos', (e) => {
        const index = e.features?.[0]?.properties?.index;
        if (typeof index === 'number') onSelectRef.current(trip.photos[index]);
      });
      m.on('mouseenter', 'photos', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'photos', () => (m.getCanvas().style.cursor = ''));

      ready.current = true;
      // Draw the initial state now that the layers exist.
      m.fire('trip:redraw');
    };

    if (m.isStyleLoaded()) addTripLayers();
    else m.on('style.load', addTripLayers);

    return () => {
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, [trip]);

  // Reveal the route and pins up to the cursor.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => {
      if (!ready.current) return;
      const visible = trip.photos.filter((p) => p.t <= cursor);
      const { solid, jumps } = routeFeatures(visible);
      (m.getSource('route-done') as maplibregl.GeoJSONSource)?.setData(lineCollection(solid));
      (m.getSource('route-jumps-done') as maplibregl.GeoJSONSource)?.setData(
        lineCollection(jumps),
      );
      (m.getSource('photos') as maplibregl.GeoJSONSource)?.setData(pointCollection(visible));
    };
    draw();
    m.on('trip:redraw', draw);
    return () => {
      m.off('trip:redraw', draw);
    };
  }, [trip, cursor]);

  // A thumbnail marker pinned to whichever photo the timeline is sitting on.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!current) {
      marker.current?.remove();
      marker.current = null;
      return;
    }

    if (!marker.current) {
      const el = document.createElement('button');
      el.className = 'map-pin';
      el.type = 'button';
      marker.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([current.lon, current.lat])
        .addTo(m);
    } else {
      marker.current.setLngLat([current.lon, current.lat]);
    }

    const el = marker.current.getElement();
    const src = current.thumbUrl ?? current.location;
    el.innerHTML = `<img src="${src}" alt="" loading="lazy" /><span class="map-pin-stem"></span>`;
    el.onclick = () => onSelectRef.current(current);
  }, [current]);

  // Keep the active photo on screen without yanking the view on every step.
  useEffect(() => {
    const m = map.current;
    if (!m || !current) return;
    if (!m.getBounds().contains([current.lon, current.lat])) {
      m.easeTo({ center: [current.lon, current.lat], duration: 700 });
    }
  }, [current]);

  return <div ref={container} className="map" />;
}
