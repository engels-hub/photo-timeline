import { useEffect, useMemo, useRef } from 'react';
import type { Trip } from './trip';
import { formatDay, formatDayTime } from './trip';
import type { TripPhoto } from './types';

interface Props {
  trip: Trip;
  cursor: number;
  current: TripPhoto | null;
  playing: boolean;
  onCursor: (t: number) => void;
  onTogglePlay: () => void;
  onOpen: (photo: TripPhoto) => void;
}

export function Timeline({
  trip,
  cursor,
  current,
  playing,
  onCursor,
  onTogglePlay,
  onOpen,
}: Props) {
  const strip = useRef<HTMLDivElement>(null);

  // Day ticks positioned proportionally along real elapsed time, so a slow day
  // and a 400 km drive occupy the space they actually took.
  const span = Math.max(1, trip.end - trip.start);
  const ticks = useMemo(
    () =>
      trip.days.map((d) => ({
        ...d,
        pct: ((d.t - trip.start) / span) * 100,
      })),
    [trip, span],
  );

  // Follow the cursor along the filmstrip, but never fight a user who is
  // scrolling it themselves mid-drag.
  useEffect(() => {
    if (!current || !strip.current) return;
    const el = strip.current.querySelector<HTMLElement>(`[data-index="${current.index}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [current]);

  return (
    <div className="timeline">
      <div className="strip" ref={strip}>
        {trip.photos.map((p) => (
          <button
            key={p.id}
            data-index={p.index}
            className={`frame${current?.index === p.index ? ' active' : ''}${
              p.t <= cursor ? '' : ' future'
            }`}
            title={formatDayTime(p.t)}
            onClick={() => {
              onCursor(p.t);
              onOpen(p);
            }}
          >
            <img src={p.thumbUrl ?? p.location} alt="" loading="lazy" decoding="async" />
          </button>
        ))}
      </div>

      <div className="scrub">
        <button
          className="play"
          onClick={onTogglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <div className="track">
          <div className="ticks">
            {ticks.map((t) => (
              <span key={t.label} className="tick" style={{ left: `${t.pct}%` }}>
                <i />
                <em>{formatDay(t.t)}</em>
              </span>
            ))}
          </div>
          <input
            type="range"
            min={trip.start}
            max={trip.end}
            value={cursor}
            step={1000}
            onChange={(e) => onCursor(Number(e.target.value))}
            aria-label="Scrub through the trip"
          />
        </div>

        <div className="readout">
          <strong>{current ? formatDayTime(current.t) : formatDay(cursor)}</strong>
          <span>
            {trip.photos.filter((p) => p.t <= cursor).length} / {trip.photos.length}
          </span>
        </div>
      </div>
    </div>
  );
}
