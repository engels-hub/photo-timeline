import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lightbox } from './Lightbox';
import { MapView } from './MapView';
import { PasswordGate, isUnlocked } from './PasswordGate';
import { Timeline } from './Timeline';
import { loadTrip, photoIndexAt, formatDay, type Trip } from './trip';
import type { TripPhoto } from './types';

/** Trip-time advanced per second of playback: one day every four seconds. */
const PLAY_RATE = 21_600;

export default function App() {
  const [unlocked, setUnlocked] = useState(isUnlocked);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!unlocked) return;
    loadTrip()
      .then((t) => {
        setTrip(t);
        setCursor(t.end);
      })
      .catch((e: Error) => setError(e.message));
  }, [unlocked]);

  const current = useMemo(() => {
    if (!trip) return null;
    const i = photoIndexAt(trip.photos, cursor);
    return i >= 0 ? trip.photos[i] : null;
  }, [trip, cursor]);

  // Playback advances trip-time by wall-clock elapsed, so the animation keeps
  // real proportions: long drives take longer than a lunch stop.
  const raf = useRef(0);
  useEffect(() => {
    if (!playing || !trip) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCursor((c) => {
        const next = c + dt * PLAY_RATE;
        if (next >= trip.end) {
          setPlaying(false);
          return trip.end;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, trip]);

  const togglePlay = useCallback(() => {
    if (!trip) return;
    setPlaying((p) => {
      // Restarting from the end should replay, not sit still.
      if (!p && cursor >= trip.end) setCursor(trip.start);
      return !p;
    });
  }, [trip, cursor]);

  const step = useCallback(
    (delta: number) => {
      if (!trip || openIndex === null) return;
      const next = Math.min(trip.photos.length - 1, Math.max(0, openIndex + delta));
      setOpenIndex(next);
      setCursor(trip.photos[next].t);
    },
    [trip, openIndex],
  );

  const open = useCallback((photo: TripPhoto) => {
    setPlaying(false);
    setOpenIndex(photo.index);
  }, []);

  if (!unlocked) return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  if (error) return <div className="status error">{error}</div>;
  if (!trip) return <div className="status">Ielādē…</div>;

  return (
    <div className="app">
      <header>
        <span className="brand">
          📸 mikro eiropa <span>karte</span>
        </span>
        <span className="stats">
          {trip.photos.length} foto · {Math.round(trip.distanceKm).toLocaleString('en-GB')} km ·{' '}
          {formatDay(trip.start)} – {formatDay(trip.end)}
        </span>
        <a href="https://trip.d0b0.lv">plāns →</a>
      </header>

      <MapView trip={trip} cursor={cursor} current={current} onSelect={open} />

      <Timeline
        trip={trip}
        cursor={cursor}
        current={current}
        playing={playing}
        onCursor={(t) => {
          setPlaying(false);
          setCursor(t);
        }}
        onTogglePlay={togglePlay}
        onOpen={open}
      />

      {openIndex !== null && (
        <Lightbox
          photo={trip.photos[openIndex]}
          total={trip.photos.length}
          onClose={() => setOpenIndex(null)}
          onStep={step}
        />
      )}
    </div>
  );
}
