# Trip Photo Timeline — investigation & plan

A map + timeline that reads photo metadata to place each shot in space and time,
draws the route travelled, and lets you scrub through the trip.

**Ingest is built and tested. The viewer is not started.** See §5 for state.

---

## 1. Decisions

Confirmed by the trip owner, and the reason each one matters:

| Decision | Consequence |
|---|---|
| All photos are unique | No content hashing, no dedup pass. |
| Discard photos lacking needed metadata | No interpolation in the core path. Every skip is still *reported*, never silent. |
| All clocks correct; **use GPS time** | Removes timezone and clock-skew handling entirely — the single largest simplification. See §2. |
| Privacy not a concern; whole site behind a password `Mikro2026` | No EXIF stripping, no home-blurring, originals may be served directly. |

Placing photos that lack metadata is explicitly **"cool to have"**, deferred to
§5 P5.

One note on the password, then I will stop raising it: a password checked in the
browser is a *doormat, not a lock* — it keeps strangers out of a link that gets
forwarded, but anyone who opens devtools can read it and fetch the photos
directly, and committing it puts it in git history permanently. That is a
perfectly reasonable trade for holiday photos, and matches "privacy does not
matter". It is only worth knowing so it is not mistaken for real access control.
If you ever want the real thing, it is HTTP basic auth at the web server, not
in the page.

---

## 2. What was verified

Tested in this environment, not assumed. Node 22.22.

| Question | Result |
|---|---|
| Read GPS + timestamp from EXIF? | **Yes.** Coordinates accurate to 6dp. |
| Read EXIF from **HEIC** without decoding pixels? | **Yes.** `exifr` ships a HEIF/HEIC ISO-BMFF parser. Container parse only, no codec needed. |
| Read EXIF from **remote** photos cheaply? | **Yes.** `exifr` issued `GET range=bytes=0-39999` rather than downloading the file — roughly 1% of a 4 MB photo. Now the basis of `HttpSource`. |
| Generate test photos with real EXIF? | **Yes.** `sharp` + `piexifjs`. Two gotchas found, both fixed in `test/helpers/fixtures.ts`. |

### Why GPS time, demonstrated

```
GPSDateStamp + GPSTimeStamp : 2026-07-14T13:32:07Z   ← true instant, UTC by spec
DateTimeOriginal            : 2026-07-14T15:32:07Z   ← naive local time, mislabelled Z
                                                        off by exactly 2h (CEST)
```

`DateTimeOriginal` is a wall-clock string with no zone; `exifr` parses it as
UTC. Using it would shift every photo by the local offset and scramble ordering
across a timezone change. GPS time carries no such ambiguity, which is what
makes decision #3 above so effective — it is not merely convenient, it removes
an entire class of bug.

### Two EXIF traps found and handled

1. `GPSTimeStamp` comes back as either a numeric triple **or** a string like
   `"13:32:7"` — note the unpadded seconds. Fixed-width parsing misreads it.
   Both shapes are handled and both are tested.
2. `piexifjs` predates EXIF 2.31: it lacks `OffsetTimeOriginal` (36881) and
   names the dimension tags `PixelXDimension`/`PixelYDimension`, which `exifr`
   surfaces under different names. Only affects fixtures, but silently breaks
   them.

Also handled: coordinates of exactly `0,0` mean "no fix", not Null Island, and
are rejected rather than dropping a pin in the Gulf of Guinea.

---

## 3. Architecture

```
photos (HTTP host | local folder)
      │
      ▼
  ingest CLI  ──►  trip.json  ──►  web viewer
```

Separated by a file, not a function call: the manifest is inspectable and
diffable, EXIF reading does not rerun on every page load, and the viewer works
identically whether photos sit on disk or behind a URL.

**Stack.** TypeScript, Node 22, npm workspaces. Ingest uses `exifr` and `sharp`.
Viewer will use MapLibre GL + React — MapLibre because it needs no API key.

**Basemap.** Default to a keyless raster style, with PMTiles as an upgrade: a
single file clipped to the trip's bounding box, served as a static asset over
range requests. No key, no rate limits, works offline.

---

## 4. The source adapter

```ts
interface PhotoSource {
  list(): AsyncIterable<PhotoRef>;
  readPrefix(ref, bytes): Promise<Uint8Array>;   // EXIF lives at the front
  readFull(ref): Promise<Uint8Array>;
  supportsPartialRead(): Promise<boolean>;
}
```

`upload.d0b0.lv` is **blocked by this environment's egress policy** (gateway
returned 403 to CONNECT; not retried, not routed around), so its API could not
be inspected. Rather than guess one listing shape and be wrong, `HttpSource`
auto-detects the four that such hosts actually serve — JSON array, JSON objects,
S3/R2 XML, HTML autoindex — each covered by a test against an in-process mock.

Pointing it at the real host is a URL change. `--probe` reports reachability,
content type, images recognised, and range support, so the first contact with
the real service is diagnosable rather than a guess.

Deliberate behaviour: a listing that parses to **zero images throws** rather
than writing an empty manifest, because "successful but empty" is the failure
mode most likely to be mistaken for "the trip has no photos".

---

## 5. Build order

**P0 — Foundations. Done.** Workspace, fixture generator producing JPEGs with
real EXIF along a synthetic route, including deliberately awkward cases.

**P1 — Ingest. Done.** Local + HTTP sources, GPS-time extraction, ordering,
bounds, skip reporting, CLI with `--probe`. 25 tests, clean typecheck. Verified
end-to-end against a mock host: 12 photos mapped, 2 correctly skipped.

**P2 — Connect the real host. Next, blocked on egress.** Run `--probe` against
`upload.d0b0.lv`, add a listing parser if it serves a shape not yet covered,
confirm EXIF survives upload.

**P3 — Viewer.** MapLibre, route line, photo pins, clustering, lightbox,
password gate. *Milestone: the trip on a map.*

**P4 — Timeline.** Scrubber, map follows it, play button animating the route.
*Milestone: the actual product.*

**P5 — "Cool to have".** Place no-metadata photos by interpolating along the
route between their neighbours, rendered as hollow markers so an inferred
position is never presented as a measured one.

---

## 6. Risks

**R1 — Upload service strips or re-encodes EXIF (high impact, unknown
likelihood).** Many upload services re-encode on ingest and discard metadata. If
`upload.d0b0.lv` does, the data this project depends on is already gone and
ingest must run against the originals. **This is the one risk that invalidates
the approach rather than merely complicating it — check it first**, via
`--probe` followed by one real photo.

**R2 — Unknown listing format (low).** Mitigated by auto-detection across four
formats and a clear failure message naming the file to edit.

**R3 — HEIC thumbnailing (low, deferred).** EXIF from HEIC is confirmed, so the
map and timeline are safe. Generating *thumbnails* from HEIC is unproven:
prebuilt `sharp` reports HEIF input support but could not be confirmed without a
real HEIC file. Fallbacks in order: `sharp`; the JPEG preview already embedded
in every iPhone HEIC; `heic-decode` (pure WASM). Only matters at P3, and one
real `.HEIC` settles it in minutes.

**R4 — Basemap terms (low).** Public OSM tile servers are for light use and a
photo-heavy page can breach that. PMTiles sidesteps it.

---

## 7. What to check on `upload.d0b0.lv`

In priority order:

1. **Does it preserve EXIF?** See R1. Everything else is secondary.
2. **Listing endpoint** — what does `GET /trip` return? `--probe` answers this.
3. **`Accept-Ranges: bytes`** — unlocks the ~1% metadata read. Without it,
   ingest still works, just downloads more.
4. **Auth** — public, token, or signed URLs? Determines whether the manifest can
   hold durable URLs or must resolve them at view time.
5. **CORS** — only needed if the browser fetches photos directly, which it will
   for the viewer.
6. **Stable IDs** — so re-running ingest does not duplicate everything.
