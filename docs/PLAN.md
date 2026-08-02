# Trip Photo Timeline — investigation & plan

A map + timeline that reads photo metadata to place each shot in space and time,
draws the route travelled, and lets you scrub through the trip. Like a Google
Maps timeline, but the pins are your photos.

Status: **planning only — no application code written yet.**

---

## 1. What was actually verified

These were tested in this environment, not assumed. Node 22.22, npm 10.9.

| Question | Result |
|---|---|
| Can we read GPS + timestamp from EXIF? | **Yes.** `exifr` returned lat/lon to 6dp and `DateTimeOriginal` from a generated fixture. |
| Can we read EXIF from **HEIC** (iPhone) without decoding pixels? | **Yes.** `exifr` ships a dedicated HEIF/HEIC ISO-BMFF parser (`file-parsers/heif.mjs`, handles `heic/heix/hevc/mif1`). Container parse only — no codec needed. |
| Can `sharp` decode HEIC to make thumbnails? | **Unresolved — see risk R1.** Prebuilt `sharp` 0.35.3 / libvips 8.18.3 reports `heif input: true`, but `avif` is missing entirely and HEIC *encode* fails with `heifsave: Unsupported compression`. Could not obtain a real HEIC to confirm decode (see §6). |
| Can we generate test photos with real EXIF? | **Yes.** `sharp` + `piexifjs` round-trips GPS, `DateTimeOriginal`, altitude. Caveat: `piexifjs` predates EXIF 2.31 and lacks `OffsetTimeOriginal` (36881) — must be registered manually, one line. |
| Can we read EXIF from **remote** photos cheaply? | **Yes, and this is the important one.** `exifr.gps(url)` issued `GET range=bytes=0-39999` instead of downloading the file. On a 4 MB photo that is ~1% of the bytes. Requires the host to honour `Accept-Ranges: bytes`. |

### The timezone landmine, demonstrated

```
DateTimeOriginal:   2026-07-14T15:32:07.000Z    <-- says "Z"
OffsetTimeOriginal: +02:00                       <-- but the real instant is 13:32:07Z
```

EXIF `DateTimeOriginal` is a **naive wall-clock string with no zone**. `exifr`
hands back a JS `Date` that has parsed it as UTC. Every photo is therefore
silently wrong by the local UTC offset unless corrected. Across a trip that
crosses a timezone, or across friends whose phones were set differently, this
alone will scramble the ordering. Handling it is not a polish item — it is
core, and it is §4.1.

---

## 2. Constraints discovered

**Photo storage is `https://upload.d0b0.lv/trip`.** This host is **blocked by
this session's egress policy** (gateway returned 403 to CONNECT). I could not
inspect its API, listing format, auth, or CORS headers. I did not attempt to
route around it.

Consequence: the ingest layer is built against a **source adapter interface**
(§3.2). A local-folder adapter ships first and is fully testable; the
`upload.d0b0.lv` adapter is a thin implementation added once its API is known.
§7 lists exactly what that service needs to expose — worth checking before
integration day, because two of the items are things a plain file host often
gets wrong.

`github.com` is likewise blocked, so dependencies come from npm only.

---

## 3. Architecture

Two halves with a **file** between them, not a function call. The manifest is a
real artifact you can inspect, diff, hand-edit, and commit.

```
  photos (local folder | upload.d0b0.lv)
        │
        ▼
  ┌───────────────┐   EXIF, clock correction,
  │  ingest CLI   │   track matching, derivatives
  └───────────────┘
        │
        ▼
   trip.json  +  media/{thumb,display}/…      ← the contract
        │
        ▼
  ┌───────────────┐
  │  web viewer   │   MapLibre + timeline + lightbox
  └───────────────┘
```

Why split: EXIF extraction is slow, occasionally needs a human decision (clock
offsets), and should not rerun on every page load. The viewer stays a dumb, fast
static site. It also means the viewer works identically whether photos live on
disk or behind a URL.

### 3.1 Stack

- **TypeScript**, Node 22, one repo, npm workspaces (`ingest/`, `web/`).
- **Ingest:** `exifr` (metadata), `sharp` (derivatives), `@tmcw/togeojson` (GPX/KML).
- **Viewer:** **MapLibre GL** + React. MapLibre because it renders vector tiles,
  is genuinely open-source, and has no API-key requirement baked in.
- **Basemap:** default to a keyless raster style. Offer **PMTiles** as an
  upgrade — a single `.pmtiles` file clipped to the trip's bounding box, served
  as a static asset, read over HTTP range requests. No key, no rate limit, no
  third party watching your friends browse the trip, works offline. A city-sized
  bbox is a few tens of MB.

### 3.2 The source adapter

Everything the ingest CLI needs from a photo store:

```ts
interface PhotoSource {
  list(): AsyncIterable<PhotoRef>;              // id, filename, byteSize, contentType
  readPrefix(ref: PhotoRef, bytes: number): Promise<Uint8Array>;  // for EXIF
  readFull(ref: PhotoRef): Promise<Uint8Array>;                   // for derivatives
}
```

`LocalFolderSource` ships first. `HttpSource` implements `readPrefix` with a
`Range` header — the mechanism proven in §1. If the host refuses ranges we fall
back to full downloads and the ingest just gets slower, not broken.

---

## 4. The problems that actually make this hard

Placing a dot on a map from `GPSLatitude` is twenty lines. These are the parts
that decide whether the result is usable or subtly wrong.

### 4.1 Time — one canonical instant per photo

Resolve the true UTC instant in this order, recording which rule fired:

1. `OffsetTimeOriginal` present (modern iPhones write it) → exact.
2. GPS present → derive the zone from coordinates via `tz-lookup`, apply the
   offset in force on that date. Handles DST correctly.
3. Neither → fall back to a per-source manual offset from config.

Store `tUtc` **and** `tLocal` + `tzOffsetMin`. Sorting and track-matching use
`tUtc`; the UI displays `tLocal`, because "we got there at 15:32" is what a
human remembers, not the UTC equivalent.

### 4.2 Multiple cameras with wrong clocks

You and your friends. One phone is 4 minutes fast, someone's camera was never
set and thinks it's 2019. Untreated, their photos land in the wrong place on the
route, and interpolated positions go badly wrong.

- Group photos into **sources** by `Make`/`Model`/serial.
- `trip.config.json` holds a per-source `clockOffsetSec`, applied at ingest.
- To *find* the offset: a `align` command. Pick the same moment shot by two
  people (the group photo at dinner), give it both filenames, and it computes
  and writes the delta. Cheap to build, turns a miserable manual task into one
  command.

### 4.3 Photos with no GPS

Common: cameras without GPS, screenshots, anything that went through a
messaging app (which strips EXIF wholesale). Timestamp usually survives even
when GPS does not.

Position them by time: interpolate along the GPS track, or between the nearest
geotagged photos either side. **Record `positionSource` and render it
differently** — a hollow marker for inferred, solid for measured. An inferred
position presented as fact is a lie the map tells confidently; the honest
version costs one field and one CSS class.

Refuse to interpolate across gaps beyond a threshold (default 2h) — an
interpolation between breakfast and dinner is a straight line through places you
never went.

### 4.4 The route line

- With a GPS track (GPX/KML from Strava, a watch, Google Timeline export): use
  it. Accurate, shows the roads actually taken.
- Without: connect geotagged photos in time order. Honest but crude — it cuts
  corners and teleports through unphotographed stretches.
- Detect long straight jumps (a flight, a train with no photos) and render them
  as a **dashed** segment rather than pretending it was a walk.

### 4.5 Privacy

Photos of a private trip carrying exact home coordinates.

- `photos/` and `dist/` are gitignored. Originals are never committed by default.
- Derivatives are generated **EXIF-stripped** — the manifest carries the
  coordinates the map needs, so the JPEGs do not have to.
- Optional `--blur-home lat,lon,radius` to drop or fuzz points inside a radius,
  for when the trip starts at someone's front door.
- Publishing is an explicit, separate decision, documented in the README rather
  than implied by a build succeeding.

### 4.6 Scale and duplicates

- Content-hash photos; the same shot AirDropped between three people appears
  once, credited to whoever shot it first.
- Cluster markers by zoom so a hundred photos at one viewpoint is one pin that
  expands.
- Manifest stays compact (short keys, rounded coords); thumbnails lazy-load.
  Target: a 3000-photo trip opens in under two seconds.

---

## 5. Build order

Each phase ends somewhere you can actually look at, so course-correction is
cheap.

**P0 — Foundations.** Workspace scaffold, TS config, `test/fixtures/` generator
producing JPEGs with real EXIF GPS/time along a synthetic route (proven in §1),
including deliberately nasty cases: no GPS, wrong clock, timezone crossing,
duplicates. This is what makes the rest testable without touching your photos.

**P1 — Ingest.** `LocalFolderSource` → EXIF → time resolution (§4.1) → `sharp`
derivatives → `trip.json`. Unit tests over the fixtures. *Milestone: a manifest
you can read.*

**P2 — Map.** MapLibre, route line, photo pins, clustering, click to open.
*Milestone: the trip on a map.*

**P3 — Timeline.** Scrubber along the bottom, map and pins follow it, play
button that animates the route. Lightbox with next/prev and location. *Milestone:
the actual product.*

**P4 — Multi-source.** GPX/KML import, `align` command, per-contributor colours
and filtering, no-GPS interpolation with honest markers.

**P5 — Integration & publish.** `HttpSource` against `upload.d0b0.lv` (§7),
deploy target, PMTiles basemap option.

P0–P3 is the demonstrable core. P4 is what makes it work for a *group* trip
rather than one person's camera roll.

---

## 6. Risks

**R1 — HEIC pixel decoding (medium).** EXIF from HEIC is confirmed working, so
mapping and timeline are safe regardless. Thumbnails are the open question:
`sharp`'s prebuilt libvips may lack a HEVC decoder. I could not settle it —
generating a HEIC needs an encoder (absent by licence) and both sample sources
were egress-blocked. Three fallbacks, in order: `sharp`; the JPEG preview
already embedded in every iPhone HEIC (`exifr.thumbnail()`); `heic-decode`
(pure WASM, no system deps). **Resolved in five minutes once you supply one real
`.HEIC` file** — worth doing early in P1.

**R2 — Unknown upload-service API (medium).** Blocked from inspection. Mitigated
by the adapter boundary; §7 is the checklist.

**R3 — EXIF-stripped photos (low, likely).** Anything shared via WhatsApp/
Telegram arrives with no metadata at all. Handled by §4.3 plus a manual
`overrides` block in config for placing stragglers by hand.

**R4 — Basemap terms (low).** Public OSM tile servers are for light use and the
policy is easy to breach with a photo-heavy page. PMTiles sidesteps it entirely;
that is why it is in the plan rather than a footnote.

---

## 7. What `upload.d0b0.lv` needs to expose

Worth confirming before P5, since these determine whether integration is an
afternoon or a fight:

1. **A listing endpoint** — ideally JSON (id, filename, size, content-type). An
   HTML index is parseable but brittle.
2. **`Accept-Ranges: bytes`** — unlocks the ~1% EXIF read from §1. Without it,
   ingest must download every full-size photo.
3. **CORS** (`Access-Control-Allow-Origin`, and `Access-Control-Expose-Headers:
   Content-Range` for ranges) — only if the browser fetches photos directly.
   Not needed if everything goes through the ingest CLI.
4. **Auth model** — public, token, signed URLs? Determines whether the manifest
   can hold durable URLs or must hold IDs resolved at view time.
5. **Stable IDs** — so re-running ingest does not duplicate everything.
6. **Whether it re-encodes or strips EXIF on upload.** If it does, the metadata
   this project depends on may already be gone by the time photos land there,
   and ingest must run against the originals instead. **Check this one first** —
   it is the only item that can invalidate the approach rather than merely
   complicate it.

---

## 8. Assumptions made

I asked about hosting, ingest style, route source, and test data, and went ahead
on defaults rather than block on the answers. Each is cheap to change now and
expensive later, so say the word if any is wrong:

- **Static site, photos not committed.** The build produces a self-contained
  folder deployable anywhere; originals stay out of git. Sharing is a separate,
  deliberate step.
- **CLI ingest first**, browser drag-and-drop deferred (it is additive — same
  parser, different source adapter).
- **GPS track when available, photo-connection otherwise.**
- **Synthetic fixtures for development**, so nothing private is needed to build
  or test. Point it at real photos whenever you like.

The one that most deserves a second look is the first: it decides whether this
ends up a private link, a public gallery, or something password-gated — and that
is a question about your friends' photos, not about code.
