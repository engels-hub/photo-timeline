# Trip photo timeline

A map and timeline of a trip, built from the photos' own metadata. Each photo is
placed by its GPS coordinates and GPS timestamp, ordered into a route, and shown
as a scrubbable timeline — a travel timeline, with your photos as the pins.

## Status

| Stage | State |
|---|---|
| Ingest: read photos → `trip.json` | **working**, 30 tests passing |
| HTTP photo source (`upload.d0b0.lv`) | **connected and running against the live album** |
| Photos currently mappable | **0 of 7** — see "The blocker" below |
| Web viewer (map, timeline, password gate) | not started |

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

## The blocker: photos are arriving without coordinates

The album is connected and ingest runs against it cleanly. The problem is the
data:

```
0 photos mapped
  6 skipped:
    2 × GPS tags present but blanked out (stripped before upload)
    3 × no GPS coordinates
    1 × no EXIF block
```

**The upload service is not at fault.** It preserves EXIF faithfully — the Pixel
photo still carries 67 tags including its HDR+ software build. What is missing
is specifically the location.

On the two phone photos the GPS tags are *present but blanked*:

```
GPSLatitude  : [null, null, null]
GPSLongitude : [null, null, null]
OffsetTimeOriginal : "+03:00"      ← time survived intact
```

Tags left in place with their values nulled is the signature of deliberate
redaction, not of a camera that never got a fix — a camera with no fix omits the
tags entirely. The most likely culprit is **Android's photo picker, which
redacts location from images handed to any app lacking the
`ACCESS_MEDIA_LOCATION` permission** — and a browser upload page goes through
exactly that picker. In other words, the coordinates are probably being stripped
by the phone at the moment of upload, and the originals still have them.

Worth testing: have someone upload one photo from a desktop browser, copied off
the phone by cable or cloud sync rather than picked on the phone. If that one
arrives with coordinates, the diagnosis is confirmed and the fix is a change of
upload route, not of code.

### What still works

Timestamps are intact and unambiguous. Both phones write
`OffsetTimeOriginal`, so `2026:07:13 15:11:16` + `+03:00` resolves to an exact
`2026-07-13T12:11:16Z` with no guessing. If coordinates cannot be recovered,
photos can still be placed by matching those timestamps against a GPS track
exported from someone's phone — the "cool to have" becomes the main mechanism.

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
