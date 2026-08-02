# Trip photo timeline

A map and timeline of a trip, built from the photos' own metadata. Each photo is
placed by its GPS coordinates and GPS timestamp, ordered into a route, and shown
as a scrubbable timeline — a travel timeline, with your photos as the pins.

## Status

| Stage | State |
|---|---|
| Ingest: read photos → `trip.json` | **working**, 25 tests passing |
| HTTP photo source (`upload.d0b0.lv`) | **written and tested against mock hosts**, not yet run against the real host — see below |
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

## Connecting the real photo host

`upload.d0b0.lv` is **blocked by this development environment's egress policy**,
so the adapter could not be run against it. It is built against mock hosts
covering the four listing formats such services serve (JSON array, JSON objects,
S3/R2 XML, HTML autoindex) and auto-detects which one it got.

Run the probe as the first step:

```bash
npm run ingest -- --probe --url https://upload.d0b0.lv/trip
```

It reports whether the host is reachable, what content type the listing is, how
many images were recognised, and whether range requests work. If `imagesFound`
is 0, the listing format needs a parser added in
`ingest/src/sources/listing.ts` — that is the only place that needs to change.

One thing worth checking before anything else: **whether the upload service
re-encodes or strips EXIF on upload.** Many do. If it does, the metadata this
project runs on is already gone by the time photos arrive there, and ingest has
to run against the originals instead.

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
