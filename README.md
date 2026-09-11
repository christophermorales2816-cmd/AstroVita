# ASTROVITA — Immersive Exoplanet Observatory

> Explore real worlds beyond our solar system.

ASTROVITA is a browser-based 3D observatory for **real exoplanets**. It pulls the
NASA Exoplanet Archive into a navigable star field, lets you fly to a world,
inspect a procedurally rendered model of it, and read its measured telemetry
with the provenance of every value spelled out. It is built to feel like a
planetarium console, not a spreadsheet — but the data underneath is the
archive's, unaltered.

---

## Features

- **Real astronomical data** — live ADQL query against the NASA Exoplanet Archive
  TAP service (`pscomppars` table), normalized into one predictable object shape.
- **Three-tier reliability** — LIVE → CACHED (localStorage, with real age shown)
  → OFFLINE (bundled snapshot of 42 well-studied worlds). The app never fails to
  load and never presents cached or snapshot data as live.
- **3D navigation field** — the catalog laid out as orbits around an observatory
  hub, with hover feedback, target-lock reticles and orbital motion.
- **Cinematic observation mode** — two-stage tweened camera approach, dimmed
  star field, staged telemetry reveal, autonomous rotation with user override.
- **Custom GLSL shaders** — simplex-noise surface shader with eight visual
  profiles (rocky, ocean, gas giant, hot Jupiter, ice, lava, Hycean, tidally
  locked) and a Fresnel atmosphere halo tinted by *detected* atmospheric species.
- **10,600-particle cosmic environment** on desktop (9,000 stars + 1,600 nebula
  sprites) in three draw calls; 6,000 on low-power devices.
- **Search, filter, sort** — by name / host star / class; rocky, giant, habitable
  zone, nearby, hot, cold, recent, transit, atmosphere detected; six sort keys.
- **Compare mode** — up to three worlds side by side, derived values labelled.
- **Favorites** — bookmarked locally with `localStorage`.
- **DISCOVER A WORLD** — random jump to a scientifically interesting target.
- **Observatory (immersive) mode** — panels slide away, the planet fills the view.
- **Explorer badges & curiosity prompts** — light discovery mechanics, clearly
  game-like, never scientific claims.
- **Accessibility** — keyboard navigation, visible focus, ARIA labels, live
  regions, non-colour-only status markers, and full `prefers-reduced-motion`
  support that damps camera, particle and UI animation without removing data.
- **Responsive** — desktop first; on phones the side panels become bottom
  sheets and the 3D scene stays fully interactive.
- **Optional, off-by-default UI audio** — a synthesized cue, no audio files.

---

## Installation

Requires Node.js 18.17 or newer.

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

## Production build

```bash
npm run build
npm run preview
```

`npm run build` emits a static site into `dist/`. There is no server component.

---

## Deployment

The Vite config uses `base: './'`, so the same build works from a domain root
or a sub-path without changes.

### Vercel

1. Import the repository.
2. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
3. Deploy. No environment variables are required.

### Netlify

1. New site from Git.
2. Build command `npm run build`, publish directory `dist`.
3. Deploy.

### GitHub Pages

```bash
npm run build
# push the contents of dist/ to a gh-pages branch, e.g.
git subtree push --prefix dist origin gh-pages
```

Then enable Pages for the `gh-pages` branch. Because `base` is relative, the
site works at `https://<user>.github.io/<repo>/`.

### Optional proxy

If your hosting network blocks direct browser calls to the archive, copy
`.env.example` to `.env` and set `VITE_EXOPLANET_PROXY` to a server-side
pass-through that forwards `query` and `format` to the TAP endpoint. The app
works without it; it will simply run from cache or the snapshot.

---

## Data sources

### NASA Exoplanet Archive (primary)

`src/services/exoplanetApi.js` issues this query to
`https://exoplanetarchive.ipac.caltech.edu/TAP/sync`:

```sql
select top 400
  pl_name, hostname, sy_snum, sy_pnum, discoverymethod, disc_year,
  pl_orbper, pl_orbsmax, pl_rade, pl_bmasse, pl_orbeccen, pl_eqt,
  st_spectype, st_teff, st_rad, st_mass, sy_vmag, sy_dist
from pscomppars
where sy_dist is not null and pl_rade is not null
order by sy_dist asc
```

No API key exists for this service and none is embedded. The 400-row cap keeps
the payload small; the full table holds thousands of planets.

### Local snapshot (fallback)

`src/data/exoplanet_registry.json` holds 42 well-studied worlds, including
every planet named in the product brief, plus ten sourced astronomy facts. Its
`meta` block states plainly that it is an offline transcription of published
archive parameters, not a live query. Where a live row matches a snapshot entry
by name, the snapshot's atmospheric-composition notes are attached and labelled
`COMPOSITION SOURCE: LITERATURE SNAPSHOT`; measured numbers from the live row
are never overwritten by snapshot values.

Snapshot values were transcribed from the archive's composite-parameters
table and the discovery/characterisation papers it aggregates. Parameters are
refined over time; treat the live query as authoritative and the snapshot as
a safety net. The `verifyAgainst` URL in the file's metadata points at the
table to check against.

### Caching

A successful archive response is stored in `localStorage` under
`astrovita.catalog.v1` with a timestamp, source and dataset version. Within six
hours it is reused without a network call and shown as `CACHED n HOURS AGO`.
After that the archive is queried again; if that fails the stale cache is
used, still labelled as cached. Cache is never shown as `LIVE`.

### Provenance in the UI

- Top bar: `NASA EXOPLANET ARCHIVE · LIVE`, `· CACHED 3 HOURS AGO`, or
  `LOCAL CATALOG SNAPSHOT · OFFLINE`.
- Each telemetry panel ends with a DATA TRUST block tagging every field as
  `MEASURED`, `ESTIMATED` (minimum mass), `DERIVED`, `ARTISTIC MODEL` or
  `UNAVAILABLE`, and links to the planet's archive record.
- A permanent footer reads `VISUALIZED ORBIT SCALE · SURFACE & ATMOSPHERE:
  ARTISTIC MODEL`.

---

## Scientific caveats

Read these before citing anything from the screen.

- **Procedural visuals are artistic.** No exoplanet in the catalog has been
  imaged at a resolution that reveals surface detail. Surfaces, cloud decks,
  colours and atmospheric halos are generated from measured bulk properties
  and detected species. They are interpretations, labelled as such.
- **Habitability does not mean life.** `HABITABLE ZONE CANDIDATE` means the
  equilibrium temperature and radius are compatible with a rocky world where
  surface liquid water *could* be stable. It says nothing about whether an
  atmosphere, water or life exists. `BIOSIGNATURE STATUS` is hard-wired to
  `NOT CONFIRMED` because no confirmed biosignature detection exists on any
  exoplanet.
- **Missing values are not fabricated.** A `null` from the archive is rendered
  as `UNKNOWN` / `NOT AVAILABLE`. Nothing is estimated to fill a gap. Sorting
  always places unknowns last.
- **Equilibrium temperature is a model quantity**, computed assuming no
  atmosphere and no greenhouse effect. It is tagged `DERIVED` even though it
  comes from the archive, because it is not a direct measurement.
- **Radial-velocity masses are minimum masses** (`M sin i`), shown with a `≥`
  prefix and tagged `ESTIMATED`.
- **Classifications are derived visualization categories**, not IAU
  designations. "Hycean Candidate" in particular is a hypothesis about a class
  of world, not an established finding for any specific planet.
- **Tidal locking is an expectation**, derived from a close orbit around a cool
  star, not a measurement.
- **Orbit layout is not to scale and not a map.** Real exoplanets orbit their
  own stars. The field arranges them around one hub by log distance, log radius
  and log period so the catalog is navigable. The UI says so permanently.
- **The cosmic background is set dressing.** Star and nebula positions are
  procedural, not a plotted sky survey.

---

## Performance

### Targets and assumptions

- **Target: 60 FPS** on a mid-tier discrete or recent integrated GPU (roughly
  GTX 1050 / Apple M1 / Intel Iris Xe class) at 1080p with device pixel ratio
  capped at 2.
- **Low-power tier** is selected automatically when the device has a coarse
  pointer and a small screen, ≤ 4 logical cores, or ≤ 4 GB reported memory.

### Particle counts

| Tier | Stars | Nebula sprites | Orbit bodies plotted | DPR cap | Sphere segments |
|------|-------|----------------|----------------------|---------|-----------------|
| high | 9,000 | 1,600          | 80                   | 2       | 96              |
| low  | 5,200 | 800            | 44                   | 1.5     | 56              |

Scientific information is identical across tiers; only rendering cost differs.

### Optimization choices

- Star field: two `THREE.Points` with a custom `ShaderMaterial`, additive
  blending, no depth write. All attributes generated once into typed arrays
  from a seeded PRNG. Zero per-star React components.
- Orbit bodies share one unit sphere geometry each and are moved by ref inside
  a single `useFrame`; hover growth is damped in the loop, not via React state.
- The observation planet is one mesh pair (surface + atmosphere shell) whose
  uniforms are updated in place when the selection changes — no shader
  recompilation, no geometry churn. The group is scaled rather than rebuilt.
- The surface shader runs 4–6 noise octaves depending on tier; the atmosphere
  shell uses cheap value noise rather than simplex.
- No post-processing pass. Bloom would cost a full-screen render target pair
  and multiple blur passes; additive glow shells give the look for the price
  of a few extra triangles. This was a deliberate trade for the 60 FPS target.
- Camera tweens run through a dedicated `@tweenjs/tween.js` `Group` updated
  once per frame; the frame loop never allocates.
- Per-frame positions are exchanged between the orbit engine, planet scene and
  camera rig through a ref-held `Map`, never through React state.
- Catalog list rows are memoized (`React.memo`) so 3D hover changes do not
  re-render hundreds of DOM nodes.
- `three` and the react-three packages are split into their own chunks.

### Cleanup strategy

- Every geometry and material is created declaratively so react-three-fiber
  disposes it on unmount.
- Camera tweens are removed on unmount (`Group.removeAll()`).
- The catalog request carries an `AbortController` signal tied to component
  lifetime; unmount cancels the fetch and stale results are ignored via a
  mounted flag.
- Keyboard listeners, media-query listeners and toast timers are removed in
  effect cleanups.
- The optional audio context is closed when audio is disabled or on unmount.

### Mobile adaptations

Lower particle count, lower pixel-ratio cap, no MSAA, fewer sphere segments
and noise octaves, fewer plotted orbit bodies, side panels collapsed into
bottom sheets, touch-friendly console buttons.

---

## Architecture

```text
NASA Exoplanet Archive TAP  ─┐
localStorage cache          ─┼─▶ exoplanetApi.js ─▶ dataNormalizer.js ─▶ App state
bundled snapshot JSON       ─┘        (transport,        (one object shape,     │
                                       timeout, cache,    derived science,      │
                                       validation)        palette)              │
                                                                                ▼
                                       ┌────────────────────────────────────────┴───┐
                                       │                                            │
                                  WebGL scene                                  DOM overlay
                          CosmicWeb · OrbitEngine ·                        HUD · PlanetCard ·
                          PlanetScene · CameraRig                          LoadingSequence
                          (shaders/)
```

- **`exoplanetApi.js`** is the only module that performs network or storage
  I/O for the catalog. It always resolves; failure states become degraded data
  sources, never exceptions reaching the UI.
- **`dataNormalizer.js`** converts archive rows and snapshot entries into one
  shape and attaches every derived layer (classification, habitability wording,
  density, insolation, tidal-lock expectation, shader palette, seed).
- **`App.jsx`** holds all UI state, applies filters/sort, and hands the same
  normalized objects to the 3D layer and the HUD.
- **`OrbitEngine.jsx`** publishes world positions per frame into a `Map` ref;
  **`PlanetScene.jsx`** and **`CameraRig.jsx`** read from it.

---

## Keyboard

| Key           | Action                                  |
|---------------|-----------------------------------------|
| `/`           | Focus catalog search                    |
| `↑ ↓ ← →`     | Step through the filtered catalog       |
| `Enter`       | Fly to the selected world               |
| `Esc`         | Close compare / leave observation mode  |
| `R`           | Discover a random world                 |
| `I`           | Toggle observatory (immersive) mode     |

---

## File manifest

```text
astrovita/
├── .env.example                       optional proxy configuration, documented
├── .gitignore
├── README.md
├── index.html                         meta, Open Graph, fonts, root mount
├── package.json
├── postcss.config.js
├── tailwind.config.js                 palette, fonts, HUD keyframes
├── vite.config.js                     relative base, chunk splitting
└── src/
    ├── main.jsx                       React root
    ├── App.jsx                        state, catalog derivation, scene + HUD wiring
    ├── index.css                      Tailwind layers, HUD component classes, reduced motion
    ├── data/
    │   └── exoplanet_registry.json    offline snapshot (42 worlds) + sourced facts
    ├── services/
    │   ├── exoplanetApi.js            TAP query, timeout, validation, cache, fallback
    │   └── dataNormalizer.js          normalization, derived science, palettes, formatting
    ├── components/
    │   ├── CosmicWeb.jsx              GPU star field, nebula, distant events, parallax
    │   ├── OrbitEngine.jsx            orbit layout, motion, hover/select, position publishing
    │   ├── PlanetScene.jsx            observation target: surface + atmosphere + lock reticle
    │   ├── CameraRig.jsx              tween.js camera states, OrbitControls management
    │   ├── HUD.jsx                    top bar, catalog, telemetry, console, compare, toasts
    │   ├── PlanetCard.jsx             memoized catalog instrument card
    │   └── LoadingSequence.jsx        boot readout and ENTER OBSERVATORY
    └── shaders/
        ├── PlanetSurfaceShader.js     simplex/fbm/ridged/domain-warp surface, 8 profiles
        └── AtmosphericShader.js       Fresnel halo, species-tinted, evidence-scaled density
```

---

## License

MIT. Exoplanet parameters are provided by the NASA Exoplanet Archive, operated
by the California Institute of Technology under contract with NASA; cite the
archive when reusing the data.
