import { useEffect, useMemo, useRef, useState } from 'react'
import PlanetCard from './PlanetCard.jsx'
import {
  buildProvenance,
  describeAtmosphere,
  formatDistance,
  formatMass,
  formatNumber,
  formatPeriod,
  formatRadius,
  formatTemperature,
  UNKNOWN,
} from '../services/dataNormalizer.js'
import { describeAge } from '../services/exoplanetApi.js'

/**
 * ASTROVITA — glassmorphic scientific HUD.
 *
 * Pure DOM overlay on top of the WebGL canvas. Owns no data: everything is
 * passed in from App so the 3D scene and the instrument panels read the same
 * normalized objects. Layout:
 *
 *   top      identity, data provenance, observation mode, explorer streak
 *   left     catalog: search, filters, sort, instrument cards
 *   right    telemetry for the locked target, revealed in stages
 *   bottom   telescope console
 *   overlays comparison table, explorer badges, DID YOU KNOW prompts
 *
 * On narrow screens the side panels collapse into bottom sheets toggled from
 * the console.
 */

/* ------------------------------------------------------------------ */
/* filter / sort definitions (shared with App)                          */
/* ------------------------------------------------------------------ */

export const FILTERS = [
  {
    id: 'rocky',
    label: 'ROCKY',
    test: (p) => (p.radiusEarth !== null ? p.radiusEarth <= 1.8 : p.massEarth !== null && p.massEarth < 6),
  },
  { id: 'giant', label: 'GAS GIANT', test: (p) => p.radiusEarth !== null && p.radiusEarth >= 5.5 },
  { id: 'habitable', label: 'HABITABLE ZONE', test: (p) => p.habitability.level >= 3 },
  { id: 'nearby', label: 'NEARBY < 50 LY', test: (p) => p.distanceLy !== null && p.distanceLy < 50 },
  { id: 'hot', label: 'HOT > 1000 K', test: (p) => p.equilibriumTemperatureK !== null && p.equilibriumTemperatureK >= 1000 },
  { id: 'cold', label: 'COLD < 200 K', test: (p) => p.equilibriumTemperatureK !== null && p.equilibriumTemperatureK <= 200 },
  { id: 'recent', label: 'DISCOVERED ≥ 2020', test: (p) => p.discoveryYear !== null && p.discoveryYear >= 2020 },
  { id: 'transit', label: 'TRANSIT', test: (p) => p.discoveryMethod === 'Transit' },
  { id: 'atmosphere', label: 'ATMOSPHERE DETECTED', test: (p) => p.atmosphere?.status === 'DETECTED' },
]

export const SORTS = [
  { id: 'distance', label: 'DISTANCE', key: (p) => p.distanceLy },
  { id: 'temperature', label: 'TEMPERATURE', key: (p) => p.equilibriumTemperatureK },
  { id: 'radius', label: 'RADIUS', key: (p) => p.radiusEarth },
  { id: 'mass', label: 'MASS', key: (p) => p.massEarth },
  { id: 'year', label: 'DISCOVERY YEAR', key: (p) => p.discoveryYear, descending: true },
  { id: 'name', label: 'NAME', key: (p) => p.name },
]

/* ------------------------------------------------------------------ */
/* hooks                                                               */
/* ------------------------------------------------------------------ */

/** True below Tailwind's `sm` breakpoint. Drives panel vs bottom-sheet layout. */
function useIsNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 639px)').matches
      : false,
  )
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const query = window.matchMedia('(max-width: 639px)')
    const handler = (event) => setNarrow(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])
  return narrow
}

/** Reveal `count` stages one after another whenever `key` changes. */
function useStagedReveal(key, count, reducedMotion) {
  const [stage, setStage] = useState(reducedMotion ? count : 0)

  useEffect(() => {
    if (reducedMotion) {
      setStage(count)
      return undefined
    }
    setStage(0)
    let current = 0
    const id = setInterval(() => {
      current += 1
      setStage(current)
      if (current >= count) clearInterval(id)
    }, 240)
    return () => clearInterval(id)
  }, [key, count, reducedMotion])

  return stage
}

/* ------------------------------------------------------------------ */
/* small building blocks                                               */
/* ------------------------------------------------------------------ */

function Section({ title, tag, visible, children }) {
  return (
    <section
      aria-label={title}
      className={`transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-25'}`}
    >
      <header className="mb-1.5 flex items-center justify-between">
        <h3 className="hud-label">{title}</h3>
        {tag && <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-500">{tag}</span>}
      </header>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function StatRow({ label, value, visible, provenance }) {
  const isUnknown = value === UNKNOWN || value === 'NOT AVAILABLE'
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-signal-cyan/10py-0.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        {provenance && visible && (
          <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate-600">{provenance}</span>
        )}
        <span
          className={`hud-value tabular-nums ${visible ? 'animate-hud-in' : ''} ${
            isUnknown ? 'text-slate-500' : ''
          }`}
        >
          {visible ? value : '— — —'}
        </span>
      </span>
    </div>
  )
}

function DataStatusChip({ dataMeta }) {
  if (!dataMeta) {
    return <span className="hud-chip">DATA · PENDING</span>
  }
  const tone =
    dataMeta.status === 'LIVE'
      ? 'text-signal-lime border-signal-lime/40 bg-signal-lime/5'
      : dataMeta.status === 'CACHED'
        ? 'text-signal-amber border-signal-amber/40 bg-signal-amber/5'
        : 'text-signal-magenta border-signal-magenta/40 bg-signal-magenta/5'
  const marker = dataMeta.status === 'LIVE' ? '●' : dataMeta.status === 'CACHED' ? '◐' : '○'
  const age = dataMeta.status === 'CACHED' ? describeAge(dataMeta.ageMs) : null

  return (
    <span className={`hud-chip ${tone}`} title={dataMeta.note ?? ''}>
      <span aria-hidden="true" className={dataMeta.status === 'LIVE' ? 'animate-blink-soft' : ''}>
        {marker}
      </span>
      <span>
        {dataMeta.source} · {age ?? dataMeta.status}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* top bar                                                             */
/* ------------------------------------------------------------------ */

function TopBar({ dataMeta, mode, observedCount, selectedPlanet, immersive }) {
  return (
    <header
      className={`pointer-events-auto absolute left-0 right-0 top-0 z-30 flex flex-wrap items-center justify-between gap-2 px-3 py-2 transition-opacity duration-300 sm:px-4 ${
        immersive ? 'opacity-40 hover:opacity-100' : ''
      }`}
    >
      <div className="glass-panel corner-brackets flex items-center gap-3 px-3 py-1.5">
        <span className="font-display text-sm font-bold tracking-[0.35em] text-white text-shadow-glow">
          ASTROVITA
        </span>
        <span className="hidden h-4 w-px bg-signal-cyan/25 sm:block" aria-hidden="true" />
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400 sm:block">
          Exoplanet Observatory
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DataStatusChip dataMeta={dataMeta} />
        <span className="hud-chip">
          <span aria-hidden="true">{mode === 'observation' ? '◉' : '◎'}</span>
          {mode === 'observation' ? 'OBSERVATION MODE' : 'NAVIGATION MODE'}
        </span>
        {selectedPlanet && mode === 'observation' && (
          <span className="hud-chip !text-white">
            <span aria-hidden="true" className="animate-blink-soft text-signal-lime">
              ▲
            </span>
            TARGET LOCKED
          </span>
        )}
        <span className="hud-chip" aria-label={`${observedCount} worlds observed`}>
          {observedCount} WORLD{observedCount === 1 ? '' : 'S'} OBSERVED
        </span>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* left: catalog                                                       */
/* ------------------------------------------------------------------ */

function CatalogPanel({
  planets,
  totalCount,
  visibleCount,
  search,
  onSearchChange,
  filters,
  onToggleFilter,
  showFavoritesOnly,
  onToggleFavoritesOnly,
  sort,
  onSortChange,
  selectedId,
  hoveredId,
  favorites,
  compareIds,
  onSelect,
  onHover,
  onToggleFavorite,
  onToggleCompare,
  onDiscover,
  searchInputRef,
  onClose,
}) {
  return (
    <aside
      aria-label="Exoplanet catalog"
      className="glass-panel corner-brackets pointer-events-auto flex h-full w-full flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-signal-cyan/10 px-3 py-2">
        <h2 className="hud-label !text-slate-200">Catalog</h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
            {planets.length} / {totalCount}
          </span>
          {onClose && (
            <button type="button" onClick={onClose} className="hud-button !px-2 !py-0.5 sm:hidden" aria-label="Close catalog">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2 px-3 py-2">
        <label className="block">
          <span className="sr-only">Search planets by name, host star or classification</span>
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="SEARCH NAME · STAR · CLASS   ( / )"
            className="hud-input"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="flex flex-wrap gap-1" role="group" aria-label="Filters">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => onToggleFilter(filter.id)}
              aria-pressed={filters.has(filter.id)}
              className="hud-button !px-2 !py-0.5 !text-[9px]"
            >
              {filter.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onToggleFavoritesOnly}
            aria-pressed={showFavoritesOnly}
            className="hud-button !px-2 !py-0.5 !text-[9px]"
          >
            ★ SAVED ({favorites.size})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2">
            <span className="hud-label whitespace-nowrap">Sort</span>
            <select
              value={sort}
              onChange={(event) => onSortChange(event.target.value)}
              className="hud-input !py-1 !text-[10px] uppercase tracking-[0.16em]"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={onDiscover} className="hud-button whitespace-nowrap !px-2 !text-[9px]" title="Select a random interesting world (R)">
            ✦ DISCOVER A WORLD
          </button>
        </div>

        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
          {visibleCount} of {planets.length} plotted in field · VISUALIZED ORBIT SCALE
        </p>
      </div>

      <ul className="panel-scroll flex-1 space-y-1.5 overflow-y-auto px-3 pb-3" aria-label="Planet list">
        {planets.length === 0 && (
          <li className="border border-dashed border-signal-cyan/20 px-3 py-6 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            No worlds match the current filters
          </li>
        )}
        {planets.map((planet) => (
          <PlanetCard
            key={planet.id}
            planet={planet}
            isSelected={planet.id === selectedId}
            isHovered={planet.id === hoveredId}
            isFavorite={favorites.has(planet.id)}
            isCompared={compareIds.includes(planet.id)}
            compareDisabled={compareIds.length >= 3}
            onSelect={onSelect}
            onHover={onHover}
            onToggleFavorite={onToggleFavorite}
            onToggleCompare={onToggleCompare}
          />
        ))}
      </ul>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* right: telemetry                                                    */
/* ------------------------------------------------------------------ */

function SpectralBars({ species, tone }) {
  if (!species.length) return null
  const color =
    tone === 'positive' ? 'bg-signal-lime' : tone === 'caution' ? 'bg-signal-amber' : 'bg-signal-cyan'
  return (
    <div className="mt-1.5 space-y-1" aria-label="Detected species">
      <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-slate-600">
        Spectral analysis · presence only, not abundance
      </p>
      {species.map((name, index) => (
        <div key={name} className="flex items-center gap-2">
          <span className="w-24 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300">
            {name}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden bg-white/5">
            <span
              className={`block h-full origin-left animate-bar-grow ${color}`}
              style={{ animationDelay: `${index * 90}ms` }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

function TelemetryPanel({ planet, reducedMotion, onClose, onExitObservation, mode }) {
  const stage = useStagedReveal(planet?.id ?? 'none', 7, reducedMotion)
  const provenance = useMemo(() => (planet ? buildProvenance(planet) : []), [planet])
  const atmosphere = useMemo(() => (planet ? describeAtmosphere(planet) : null), [planet])

  if (!planet) {
    return (
      <aside
        aria-label="Telemetry"
        className="glass-panel corner-brackets pointer-events-auto flex h-full w-full flex-col items-center justify-center px-6 text-center"
      >
        <p className="hud-label mb-2">No target</p>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
          Select a world in the field or the catalog to acquire telemetry.
        </p>
      </aside>
    )
  }

  const habitabilityTone =
    planet.habitability.level >= 3
      ? 'text-signal-lime'
      : planet.habitability.level === 2
        ? 'text-signal-cyan'
        : planet.habitability.level === 1
          ? 'text-signal-amber'
          : 'text-slate-400'

  return (
    <aside
      aria-label={`Telemetry for ${planet.name}`}
      className="glass-panel corner-brackets pointer-events-auto relative flex h-full w-full flex-col overflow-hidden"
    >
      <div className="scanline-overlay pointer-events-none absolute inset-x-0 h-24 animate-scan-sweep opacity-60" aria-hidden="true" />

      <div className="flex items-start justify-between border-b border-signal-cyan/10 px-3 py-2">
        <div className="min-w-0">
          <p className="hud-label">{stage >= 1 ? 'Target acquired' : 'Acquiring…'}</p>
          <h2 className="truncate font-display text-base font-bold tracking-[0.14em] text-white">
            {planet.name}
          </h2>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-signal-violet">
            {planet.classification} <span className="text-slate-500">· derived</span>
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          {mode === 'observation' && (
            <button type="button" onClick={onExitObservation} className="hud-button !px-2 !py-1 !text-[9px]" title="Return to the star field (Esc)">
              ◂ FIELD
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="hud-button !px-2 !py-1 sm:hidden" aria-label="Close telemetry">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="panel-scroll flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <Section title="Identity" visible={stage >= 1}>
          <StatRow label="System" value={planet.hostStarName} visible={stage >= 1} />
          <StatRow label="Distance" value={formatDistance(planet.distanceLy)} visible={stage >= 1} provenance={provenance[0].tag} />
          {planet.planetsInSystem !== null && planet.planetsInSystem !== undefined && (
            <StatRow label="Planets in system" value={formatNumber(planet.planetsInSystem, { digits: 0 })} visible={stage >= 1} />
          )}
          {planet.classificationTags.length > 0 && stage >= 1 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {planet.classificationTags.map((tag) => (
                <span key={tag} className="hud-chip !text-[8px]">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title="Orbital parameters" tag="MEASURED" visible={stage >= 2}>
          <StatRow label="Orbital period" value={formatPeriod(planet.orbitalPeriodDays)} visible={stage >= 2} />
          <StatRow
            label="Semi-major axis"
            value={planet.semiMajorAxisAu === null ? UNKNOWN : `${formatNumber(planet.semiMajorAxisAu, { digits: 4 })} AU`}
            visible={stage >= 2}
          />
          <StatRow
            label="Eccentricity"
            value={planet.eccentricity === null ? UNKNOWN : formatNumber(planet.eccentricity, { digits: 4 })}
            visible={stage >= 2}
          />
          <StatRow
            label="Insolation"
            value={planet.insolationEarth === null ? UNKNOWN : `${formatNumber(planet.insolationEarth, { digits: 2 })} × Earth`}
            visible={stage >= 2}
            provenance="DERIVED"
          />
        </Section>

        <Section title="Planetary profile" visible={stage >= 3}>
          <StatRow label="Radius" value={formatRadius(planet.radiusEarth)} visible={stage >= 3} provenance={provenance[1].tag} />
          <StatRow label="Mass" value={formatMass(planet.massEarth, planet.massIsMinimum)} visible={stage >= 3} provenance={provenance[2].tag} />
          <StatRow
            label="Density"
            value={planet.densityGCm3 === null ? UNKNOWN : `${formatNumber(planet.densityGCm3, { digits: 2 })} g/cm³`}
            visible={stage >= 3}
            provenance="DERIVED"
          />
          <StatRow label="Eq. temperature" value={formatTemperature(planet.equilibriumTemperatureK)} visible={stage >= 3} provenance="DERIVED" />
          <StatRow label="Tidal lock" value={planet.tidallyLockedCandidate ? 'CANDIDATE' : 'NOT INDICATED'} visible={stage >= 3} provenance="DERIVED" />
        </Section>

        <Section title="Atmospheric profile" tag="ARTISTIC ATMOSPHERIC MODEL" visible={stage >= 4}>
          <StatRow label="Status" value={atmosphere.headline} visible={stage >= 4} />
          {stage >= 4 && <SpectralBars species={atmosphere.species} tone={atmosphere.tone} />}
          {stage >= 4 && atmosphere.note && (
            <p className="pt-1 font-mono text-[10px] leading-relaxed text-slate-400">{atmosphere.note}</p>
          )}
          {stage >= 4 && planet.atmosphereProvenance && (
            <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate-600">
              Composition source: {planet.atmosphereProvenance}
            </p>
          )}
          <StatRow label="Biosignature status" value={planet.biosignatureStatus} visible={stage >= 4} />
        </Section>

        <Section title="Stellar parameters" tag="MEASURED" visible={stage >= 5}>
          <StatRow label="Star" value={planet.hostStarName} visible={stage >= 5} />
          <StatRow label="Star type" value={planet.hostStarType ?? UNKNOWN} visible={stage >= 5} />
          <StatRow
            label="Star temperature"
            value={planet.hostStarTemperatureK === null ? UNKNOWN : `${formatNumber(planet.hostStarTemperatureK, { digits: 0 })} K`}
            visible={stage >= 5}
          />
          <StatRow
            label="Star radius"
            value={planet.hostStarRadiusSolar === null ? UNKNOWN : `${formatNumber(planet.hostStarRadiusSolar, { digits: 3 })} R☉`}
            visible={stage >= 5}
          />
          <StatRow
            label="Apparent magnitude"
            value={planet.stellarMagnitude === null ? UNKNOWN : formatNumber(planet.stellarMagnitude, { digits: 2 })}
            visible={stage >= 5}
          />
        </Section>

        <Section title="Discovery" visible={stage >= 6}>
          <StatRow label="Discovered" value={planet.discoveryYear === null ? UNKNOWN : String(planet.discoveryYear)} visible={stage >= 6} />
          <StatRow label="Method" value={planet.discoveryMethod} visible={stage >= 6} />
          <StatRow label="Observation status" value={mode === 'observation' ? 'LOCKED · INSPECTING' : 'TRACKED'} visible={stage >= 6} />
          <StatRow label="Habitability" value={planet.habitability.label} visible={stage >= 6} provenance="DERIVED" />
          {stage >= 6 && (
            <p className={`pt-1 font-mono text-[10px] leading-relaxed ${habitabilityTone}`}>{planet.habitability.detail}</p>
          )}
          {stage >= 6 && planet.highlights.length > 0 && (
            <ul className="space-y-1 pt-1">
              {planet.highlights.map((line) => (
                <li key={line} className="font-mono text-[10px] leading-relaxed text-slate-300">
                  <span className="mr-1 text-signal-cyan/60">▹</span>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Data trust" visible={stage >= 7}>
          <div className="grid grid-cols-2 gap-x-3">
            {provenance.map((row) => (
              <div key={row.field} className="flex items-baseline justify-between gap-2 py-0.5">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">{row.field}</span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.14em] ${
                    row.tag === 'MEASURED'
                      ? 'text-signal-lime'
                      : row.tag === 'DERIVED' || row.tag === 'ESTIMATED'
                        ? 'text-signal-cyan'
                        : row.tag === 'ARTISTIC MODEL'
                          ? 'text-signal-magenta'
                          : 'text-slate-600'
                  }`}
                >
                  {row.tag}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-signal-cyan/10 pt-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
              Source: {planet.source}
            </span>
            <a
              href={planet.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[9px] uppercase tracking-[0.16em] text-signal-cyan underline-offset-4 hover:underline"
            >
              Archive record ↗
            </a>
          </div>
        </Section>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* bottom: telescope console                                           */
/* ------------------------------------------------------------------ */

function Console({
  mode,
  hasTarget,
  autoRotate,
  onToggleAutoRotate,
  onFocus,
  onReset,
  onExit,
  compareCount,
  onToggleCompareOpen,
  compareOpen,
  onDiscover,
  immersive,
  onToggleImmersive,
  audioEnabled,
  onToggleAudio,
  mobilePanel,
  onSetMobilePanel,
}) {
  return (
    <nav
      aria-label="Telescope console"
      className={`pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex justify-center px-2 pb-5 transition-all duration-300 sm:pb-3 ${
        immersive ? 'translate-y-[calc(100%-14px)] opacity-60 hover:translate-y-0 hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100' : ''
      }`}
    >
      <div className="glass-panel corner-brackets flex max-w-full flex-wrap items-center justify-center gap-1 px-2 py-1.5 [&>button]:!px-2 [&>button]:!py-1 sm:[&>button]:!px-3 sm:[&>button]:!py-2">
        <button type="button" onClick={() => onSetMobilePanel(mobilePanel === 'catalog' ? null : 'catalog')} aria-pressed={mobilePanel === 'catalog'} className="hud-button sm:hidden">
          CATALOG
        </button>
        <button type="button" onClick={() => onSetMobilePanel(mobilePanel === 'telemetry' ? null : 'telemetry')} aria-pressed={mobilePanel === 'telemetry'} className="hud-button sm:hidden">
          TELEMETRY
        </button>

        <button type="button" onClick={onToggleAutoRotate} aria-pressed={autoRotate} className="hud-button" disabled={!hasTarget} title="Toggle autonomous rotation">
          ↻ ROTATE
        </button>
        <button type="button" onClick={onFocus} className="hud-button" disabled={!hasTarget} title="Fly to the selected planet (Enter)">
          ◎ FOCUS
        </button>
        <button type="button" onClick={onReset} className="hud-button" title="Reset camera">
          ⟲ RESET
        </button>
        {mode === 'observation' && (
          <button type="button" onClick={onExit} className="hud-button" title="Back to the star field (Esc)">
            ◂ FIELD
          </button>
        )}
        <button type="button" onClick={onToggleCompareOpen} aria-pressed={compareOpen} className="hud-button" disabled={compareCount < 2} title="Compare selected worlds">
          ⇄ COMPARE {compareCount > 0 ? `(${compareCount})` : ''}
        </button>
        <button type="button" onClick={onDiscover} className="hud-button" title="Discover a random world (R)">
          ✦ DISCOVER
        </button>
        <button type="button" onClick={onToggleImmersive} aria-pressed={immersive} className="hud-button" title="Observatory mode: hide panels (I)">
          ▣ OBSERVATORY
        </button>
        <button type="button" onClick={onToggleAudio} aria-pressed={audioEnabled} className="hud-button" title="Subtle UI audio (off by default)">
          {audioEnabled ? '♪ AUDIO ON' : '♪ AUDIO'}
        </button>
      </div>
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/* compare overlay                                                     */
/* ------------------------------------------------------------------ */

const COMPARE_ROWS = [
  { label: 'Classification', get: (p) => p.classification, tag: 'DERIVED' },
  { label: 'Distance', get: (p) => formatDistance(p.distanceLy) },
  { label: 'Radius', get: (p) => formatRadius(p.radiusEarth) },
  { label: 'Mass', get: (p) => formatMass(p.massEarth, p.massIsMinimum) },
  { label: 'Density', get: (p) => (p.densityGCm3 === null ? UNKNOWN : `${formatNumber(p.densityGCm3, { digits: 2 })} g/cm³`), tag: 'DERIVED' },
  { label: 'Eq. temperature', get: (p) => formatTemperature(p.equilibriumTemperatureK), tag: 'DERIVED' },
  { label: 'Orbital period', get: (p) => formatPeriod(p.orbitalPeriodDays) },
  { label: 'Semi-major axis', get: (p) => (p.semiMajorAxisAu === null ? UNKNOWN : `${formatNumber(p.semiMajorAxisAu, { digits: 4 })} AU`) },
  { label: 'Insolation', get: (p) => (p.insolationEarth === null ? UNKNOWN : `${formatNumber(p.insolationEarth, { digits: 2 })} × Earth`), tag: 'DERIVED' },
  { label: 'Host star', get: (p) => `${p.hostStarName}${p.hostStarType ? ` · ${p.hostStarType}` : ''}` },
  { label: 'Star temperature', get: (p) => (p.hostStarTemperatureK === null ? UNKNOWN : `${formatNumber(p.hostStarTemperatureK, { digits: 0 })} K`) },
  { label: 'Atmosphere', get: (p) => describeAtmosphere(p).headline },
  { label: 'Habitability', get: (p) => p.habitability.label, tag: 'DERIVED' },
  { label: 'Discovered', get: (p) => (p.discoveryYear === null ? UNKNOWN : `${p.discoveryYear} · ${p.discoveryMethod}`) },
  { label: 'Source', get: (p) => p.source },
]

function ComparePanel({ planets, onClose, onRemove, onSelect }) {
  const closeRef = useRef(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compare worlds"
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-void-900/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="glass-panel corner-brackets flex max-h-full w-full max-w-5xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-signal-cyan/10 px-4 py-2">
          <h2 className="hud-label !text-slate-100">Comparative analysis</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="hud-button !px-2 !py-1" aria-label="Close comparison">
            ✕ CLOSE
          </button>
        </div>
        <div className="panel-scroll overflow-auto">
          <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 bg-void-900/90 px-3 py-2 text-left hud-label">
                  Parameter
                </th>
                {planets.map((planet) => (
                  <th key={planet.id} scope="col" className="px-3 py-2 text-left align-top">
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-1 h-3 w-3 flex-none rounded-full"
                        style={{
                          background: `radial-gradient(circle at 35% 35%, ${planet.palette.high}, ${planet.palette.low})`,
                          boxShadow: `0 0 8px ${planet.palette.glow}`,
                        }}
                      />
                      <div>
                        <button type="button" onClick={() => onSelect(planet.id)} className="font-display text-xs tracking-[0.12em] text-white hover:text-signal-cyan">
                          {planet.name}
                        </button>
                        <button type="button" onClick={() => onRemove(planet.id)} className="block font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500 hover:text-signal-red" aria-label={`Remove ${planet.name} from comparison`}>
                          remove
                        </button>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.label} className="border-t border-signal-cyan/10">
                  <th scope="row" className="sticky left-0 bg-void-900/90 px-3 py-1.5 text-left font-normal">
                    <span className="uppercase tracking-[0.14em] text-slate-400">{row.label}</span>
                    {row.tag && <span className="ml-1 text-[8px] uppercase tracking-[0.14em] text-slate-600">{row.tag}</span>}
                  </th>
                  {planets.map((planet) => {
                    const value = row.get(planet)
                    return (
                      <td key={planet.id} className={`px-3 py-1.5 tabular-nums ${value === UNKNOWN ? 'text-slate-500' : 'text-slate-100'}`}>
                        {value}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-signal-cyan/10 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">
          Values marked derived are computed by ASTROVITA from measured parameters. Unknown means the archive holds no value.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* toasts                                                              */
/* ------------------------------------------------------------------ */

function Toast({ title, body, tone, onDismiss }) {
  return (
    <div
      role="status"
      className={`glass-panel corner-brackets pointer-events-auto flex max-w-sm animate-hud-in items-start gap-3 px-3 py-2 ${
        tone === 'badge' ? 'border-signal-amber/40' : 'border-signal-violet/40'
      }`}
    >
      <span aria-hidden="true" className={`mt-0.5 text-base ${tone === 'badge' ? 'text-signal-amber' : 'text-signal-violet'}`}>
        {tone === 'badge' ? '✦' : '?'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="hud-label !text-slate-200">{title}</p>
        <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-slate-300">{body}</p>
      </div>
      <button type="button" onClick={onDismiss} className="hud-button !px-1.5 !py-0.5" aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* root                                                                */
/* ------------------------------------------------------------------ */

export default function HUD(props) {
  const {
    planets,
    totalCount,
    visibleCount,
    dataMeta,
    mode,
    selectedPlanet,
    hoveredId,
    favorites,
    compareIds,
    comparePlanets,
    observedCount,
    search,
    onSearchChange,
    filters,
    onToggleFilter,
    showFavoritesOnly,
    onToggleFavoritesOnly,
    sort,
    onSortChange,
    onSelect,
    onHover,
    onToggleFavorite,
    onToggleCompare,
    onRemoveCompare,
    onDiscover,
    onFocus,
    onReset,
    onExitObservation,
    autoRotate,
    onToggleAutoRotate,
    immersive,
    onToggleImmersive,
    audioEnabled,
    onToggleAudio,
    compareOpen,
    onToggleCompareOpen,
    badgeToast,
    onDismissBadge,
    factToast,
    onDismissFact,
    reducedMotion,
    searchInputRef,
  } = props

  const [mobilePanel, setMobilePanel] = useState(null)
  const narrow = useIsNarrow()

  // Any new target on a phone pulls the telemetry sheet up.
  useEffect(() => {
    if (narrow && selectedPlanet && mode === 'observation') setMobilePanel('telemetry')
  }, [narrow, selectedPlanet, mode])

  const panelsHidden = immersive

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      <TopBar
        dataMeta={dataMeta}
        mode={mode}
        observedCount={observedCount}
        selectedPlanet={selectedPlanet}
        immersive={immersive}
      />

      {/* Desktop side panels — not mounted at all on narrow screens. */}
      {!narrow && (
      <div
        className={`absolute inset-y-16 left-3 w-[21rem] transition-all duration-500 ${
          panelsHidden ? 'pointer-events-none -translate-x-[110%] opacity-0' : ''
        }`}
      >
        <CatalogPanel
          planets={planets}
          totalCount={totalCount}
          visibleCount={visibleCount}
          search={search}
          onSearchChange={onSearchChange}
          filters={filters}
          onToggleFilter={onToggleFilter}
          showFavoritesOnly={showFavoritesOnly}
          onToggleFavoritesOnly={onToggleFavoritesOnly}
          sort={sort}
          onSortChange={onSortChange}
          selectedId={selectedPlanet?.id ?? null}
          hoveredId={hoveredId}
          favorites={favorites}
          compareIds={compareIds}
          onSelect={onSelect}
          onHover={onHover}
          onToggleFavorite={onToggleFavorite}
          onToggleCompare={onToggleCompare}
          onDiscover={onDiscover}
          searchInputRef={searchInputRef}
        />
      </div>
      )}

      {!narrow && (
      <div
        className={`absolute inset-y-16 right-3 w-[22rem] transition-all duration-500 ${
          panelsHidden ? 'pointer-events-none translate-x-[110%] opacity-0' : ''
        }`}
      >
        <TelemetryPanel planet={selectedPlanet} reducedMotion={reducedMotion} onExitObservation={onExitObservation} mode={mode} />
      </div>
      )}

      {/* Mobile bottom sheets */}
      {narrow && mobilePanel && !panelsHidden && (
        <div className="absolute inset-x-2 bottom-[7.75rem] top-28">
          {mobilePanel === 'catalog' ? (
            <CatalogPanel
              planets={planets}
              totalCount={totalCount}
              visibleCount={visibleCount}
              search={search}
              onSearchChange={onSearchChange}
              filters={filters}
              onToggleFilter={onToggleFilter}
              showFavoritesOnly={showFavoritesOnly}
              onToggleFavoritesOnly={onToggleFavoritesOnly}
              sort={sort}
              onSortChange={onSortChange}
              selectedId={selectedPlanet?.id ?? null}
              hoveredId={hoveredId}
              favorites={favorites}
              compareIds={compareIds}
              onSelect={(id) => {
                onSelect(id)
                setMobilePanel('telemetry')
              }}
              onHover={onHover}
              onToggleFavorite={onToggleFavorite}
              onToggleCompare={onToggleCompare}
              onDiscover={onDiscover}
              searchInputRef={searchInputRef}
              onClose={() => setMobilePanel(null)}
            />
          ) : (
            <TelemetryPanel
              planet={selectedPlanet}
              reducedMotion={reducedMotion}
              onClose={() => setMobilePanel(null)}
              onExitObservation={onExitObservation}
              mode={mode}
            />
          )}
        </div>
      )}

      {/* Toasts */}
      <div className="absolute left-1/2 top-[7.5rem] z-30 flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col items-stretch gap-2 sm:top-16">
        {badgeToast && (
          <Toast title={`Explorer badge · ${badgeToast.title}`} body={badgeToast.body} tone="badge" onDismiss={onDismissBadge} />
        )}
        {factToast && <Toast title="Did you know?" body={`${factToast.text} — ${factToast.source}`} tone="fact" onDismiss={onDismissFact} />}
      </div>

      <Console
        mode={mode}
        hasTarget={Boolean(selectedPlanet)}
        autoRotate={autoRotate}
        onToggleAutoRotate={onToggleAutoRotate}
        onFocus={onFocus}
        onReset={onReset}
        onExit={onExitObservation}
        compareCount={compareIds.length}
        compareOpen={compareOpen}
        onToggleCompareOpen={onToggleCompareOpen}
        onDiscover={onDiscover}
        immersive={immersive}
        onToggleImmersive={onToggleImmersive}
        audioEnabled={audioEnabled}
        onToggleAudio={onToggleAudio}
        mobilePanel={mobilePanel}
        onSetMobilePanel={setMobilePanel}
      />

      {compareOpen && comparePlanets.length >= 2 && (
        <ComparePanel planets={comparePlanets} onClose={onToggleCompareOpen} onRemove={onRemoveCompare} onSelect={onSelect} />
      )}
    </div>
  )
}
