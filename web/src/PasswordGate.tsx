import { useState, type FormEvent } from 'react';

/**
 * A doormat, not a lock.
 *
 * This keeps a forwarded link from opening to strangers. It is not access
 * control: the password ships inside the bundle, so anyone who opens devtools
 * can read it, and the photo URLs are fetchable directly regardless. Real
 * protection would be HTTP basic auth at the web server. That trade is
 * deliberate here — these are holiday photos, and the album already sits behind
 * its own cookie.
 */
const PASSWORD = import.meta.env.VITE_TRIP_PASSWORD ?? 'Mikro2026';
const STORAGE_KEY = 'trip-unlocked';

export function isUnlocked(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === PASSWORD;
  } catch {
    return false;
  }
}

export function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value === PASSWORD) {
      try {
        localStorage.setItem(STORAGE_KEY, PASSWORD);
      } catch {
        // Private browsing: unlock for this session only.
      }
      onUnlock();
    } else {
      setWrong(true);
      setValue('');
    }
  };

  return (
    <div className="gate">
      <form onSubmit={submit}>
        <h1>
          📸 mikro eiropa <span>karte</span>
        </h1>
        <p>Ievadi paroli, lai apskatītu ceļojuma karti.</p>
        <input
          type="password"
          value={value}
          autoFocus
          placeholder="parole"
          onChange={(e) => {
            setValue(e.target.value);
            setWrong(false);
          }}
        />
        <button type="submit">Atvērt</button>
        {wrong && <div className="error">Nepareiza parole</div>}
      </form>
    </div>
  );
}
