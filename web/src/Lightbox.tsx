import { useEffect } from 'react';
import { formatDayTime } from './trip';
import type { TripPhoto } from './types';

interface Props {
  photo: TripPhoto;
  total: number;
  onClose: () => void;
  onStep: (delta: number) => void;
}

export function Lightbox({ photo, total, onClose, onStep }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onStep(-1);
      else if (e.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lb-body" onClick={(e) => e.stopPropagation()}>
        <img
          key={photo.id}
          src={photo.previewUrl ?? photo.location}
          alt={photo.filename}
        />
        <div className="lb-bar">
          <div>
            <strong>{formatDayTime(photo.t)}</strong>
            <span>
              {photo.lat.toFixed(4)}, {photo.lon.toFixed(4)}
              {photo.alt !== undefined ? ` · ${Math.round(photo.alt)} m` : ''}
              {photo.model ? ` · ${photo.model}` : ''}
            </span>
          </div>
          <div className="lb-actions">
            <span className="counter">
              {photo.index + 1} / {total}
            </span>
            <a href={photo.location} target="_blank" rel="noreferrer">
              full size
            </a>
          </div>
        </div>
      </div>

      <button
        className="lb-nav prev"
        onClick={(e) => {
          e.stopPropagation();
          onStep(-1);
        }}
        aria-label="Previous photo"
      >
        ‹
      </button>
      <button
        className="lb-nav next"
        onClick={(e) => {
          e.stopPropagation();
          onStep(1);
        }}
        aria-label="Next photo"
      >
        ›
      </button>
      <button className="lb-close" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}
