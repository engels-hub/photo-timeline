# Trip photo timeline

A map and timeline of a trip, built from the photos' own metadata. Each photo is
placed by its GPS coordinates and GPS timestamp, ordered into a route, and shown
as a scrubbable timeline — a travel timeline, with your photos as the pins.

## Status

| Stage | State |
|---|---|
| Ingest: read photos → `trip.json` | **working**, 30 tests passing |
| HTTP photo source (`upload.d0b0.lv`) | **connected and running against the live album** |
| Photos mapped | **139**, 2,475 km, 25 Jul – 4 Aug |
| Web viewer (map, timeline, lightbox, password gate) | **working** |

## Quick start

```bash
npm install

# See what a photo host exposes, without ingesting anything
npm run ingest -- --probe --url https://upload.d0b0.lv/trip

# Build the manifest
npm run ingest -- --url https://upload.d0b0.lv/trip --out web/public/trip.json

# Or from a local folder
npm run ingest -- --dir ~/Pictures/trip

npm test
npm run typecheck
```

If the listing needs authentication, pass headers through:

```bash
npm run ingest -- --url https://upload.d0b0.lv/trip --header "Authorization: Bearer …"
```

## How it works

```
photos (HTTP host | local folder)
      │   reads only the first ~128 KB of each file — EXIF lives at the front
      ▼
  ingest CLI
      │
      ▼
  trip.json  ──►  web viewer
```

Ingest and viewer are separated by a file rather than a function call, so the
manifest is something you can open, diff, and hand-edit, and the viewer stays a
fast static site regardless of where the photos live.

### Time

Timestamps come from `GPSDateStamp` + `GPSTimeStamp`, which are UTC by EXIF
spec. `DateTimeOriginal` is deliberately **not** used: it is a naive local
wall-clock string with no timezone, and parsing it as UTC shifts photos by the
local offset — measured at exactly 2 hours for a CEST photo during development.
Using GPS time means clocks and timezones need no correction at all.

### Photos that get dropped

A photo needs GPS coordinates and a GPS timestamp to appear. Anything else is
skipped and recorded in `manifest.skipped` with a reason, so the count is
always explainable:

```
12 photos mapped in 0.1s → web/public/trip.json
  2026-07-14T09:00:00.000Z → 2026-07-14T11:12:00.000Z
  bounds 41.3874,2.1686 → 41.4105,2.2060

  2 skipped:
    1 × no EXIF block
    1 × no GPS coordinates
```

Expect anything sent through WhatsApp or Telegram to land in that list —
those strip EXIF wholesale.

## Photos uploaded from a phone browser lose their coordinates

Solved, and worth recording because it will recur.

Photos uploaded through a **phone** browser arrive with their GPS tags present
but blanked — `GPSLatitude: [null, null, null]` — while `DateTimeOriginal` and
`OffsetTimeOriginal` survive untouched. Tags left in place with their values
emptied indicates redaction, not a camera without a fix; a camera with no fix
omits the tags entirely. The phone strips location as the file is handed to the
browser.

The upload service is not at fault: it preserves EXIF faithfully. Photos
uploaded from a **PC** keep everything, which is how the current 139 got here.

Ingest reports the two cases separately, so the cause stays visible:

```
  7 skipped:
    3 × GPS tags present but blanked out (stripped before upload)
    3 × no GPS coordinates
    1 × no EXIF block
```

Time is resolved from GPS timestamps when present, falling back to
`DateTimeOriginal` + `OffsetTimeOriginal`, which is equally exact. A bare
`DateTimeOriginal` with no offset is refused rather than silently treated as
UTC.

## The viewer

```bash
npm run dev      # http://localhost:5173
npm run build    # -> web/dist
```

Dark map, the route in orange, a filmstrip and a time scrubber along the bottom.
Scrubbing reveals the route progressively: travelled portion bright, the rest
dim, so the shape of the whole trip stays legible from the first day. Press play
to animate it. Photos are pinned by their coordinates; clicking a pin or a
filmstrip frame opens the photo with its time, position, altitude and camera.

A few decisions worth knowing:

- **Layers are added on `style.load`, not `load`.** MapLibre's `load` waits for
  basemap tiles, so a blocked or slow tile CDN would leave the trip itself
  undrawn. The route is our data and must never depend on someone else's server.
- **Dashed legs are chosen by implied speed, not distance.** On a road trip,
  consecutive photos are routinely hundreds of kilometres apart simply because
  nobody photographed the motorway; dashing those makes the whole route look
  like guesswork. A leg is only dashed when it could not have been travelled on
  the ground (over 200 km/h implied). For this trip that flags 0 of 138 legs,
  which is correct — it was driven.
- **Thumbnails come from the album's own `/thumb` endpoint**, so this project
  generates no derivatives at all.
- **The password is a doormat, not a lock.** It keeps a forwarded link from
  opening to strangers. It ships inside the bundle, so anyone who opens devtools
  can read it, and the photo URLs are fetchable directly regardless. Real
  protection would be HTTP basic auth at the web server.

Photos load from `upload.d0b0.lv`, which requires the `trip_auth` cookie. Hosted
under any `*.d0b0.lv` subdomain the browser sends that cookie automatically;
served from anywhere else the images will 403.

## Using the album

```bash
export TRIP_AUTH_COOKIE='trip_auth=…'      # secret: never commit this
npm run ingest -- --d0b0
npm run ingest -- --d0b0 --folder Trip_photos --out web/public/trip.json
```

The album's API, read from the upload page's own JavaScript:

| Endpoint | Purpose |
|---|---|
| `GET /api/files?folder=…` | listing → `{ files: [{ name, size, image }] }` |
| `GET /file?folder=…&name=…` | original bytes, honours `Range` |
| `GET /thumb?folder=…&name=…` | server-generated thumbnail |
| `GET /thumb?big=1&…` | larger preview |

The server already generates thumbnails, so the viewer can use those instead of
this project building its own.

## Layout

```
ingest/src/
  cli.ts               command line entry point
  ingest.ts            orchestration, ordering, bounds
  exif.ts              metadata extraction and GPS-time handling
  sources/
    types.ts           the PhotoSource interface
    local.ts           local folder
    http.ts            HTTP host, range requests, probe
    listing.ts         directory listing parsers
ingest/test/           25 tests, incl. in-process mock hosts
docs/PLAN.md           investigation notes and build order
```
