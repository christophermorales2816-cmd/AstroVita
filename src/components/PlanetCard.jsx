import { memo } from 'react'
import { formatDistance, formatNumber, formatRadius } from '../services/dataNormalizer.js'

/**
 * ASTROVITA — catalog instrument card.
 *
 * One row of the catalog list. Styled as an instrument readout rather than a
 * web card: monospace telemetry, bracket corners, a colour swatch derived from
 * the planet's (artistic) atmosphere palette, and explicit provenance.
 *
 * Memoised because the list can hold hundreds of entries and re-renders on
 * every hover change in the 3D scene.
 */

function habitabilityTone(level) {
  if (level >= 3) return 'text-signal-lime'
  if (level === 2) return 'text-signal-cyan'
  if (level === 1) return 'text-signal-amber'
  return 'text-slate-400'
}

function PlanetCard({
  planet,
  isSelected,
  isHovered,
  isFavorite,
  isCompared,
  compareDisabled,
  onSelect,
  onHover,
  onToggleFavorite,
  onToggleCompare,
}) {
  const temperature = planet.equilibriumTemperatureK

  return (
    <li
      className={[
        'corner-brackets group relative border transition-colors duration-150',
        isSelected
          ? 'border-signal-cyan/70 bg-signal-cyan/10'
          : isHovered
            ? 'border-signal-cyan/40 bg-signal-cyan/5'
            : 'border-signal-cyan/10 bg-void-800/40 hover:border-signal-cyan/35',
      ].join(' ')}
      onMouseEnter={() => onHover(planet.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        onClick={() => onSelect(planet.id)}
        aria-pressed={isSelected}
        aria-label={`Observe ${planet.name}, ${planet.classification}`}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className="mt-1 h-3 w-3 flex-none rounded-full ring-2 ring-white/10"
          style={{
            background: `radial-gradient(circle at 35% 35%, ${planet.palette.high}, ${planet.palette.low})`,
            boxShadow: `0 0 10px ${planet.palette.glow}`,
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-display text-xs tracking-[0.12em] text-slate-100">
              {planet.name}
            </span>
            <span className="flex-none font-mono text-[10px] text-slate-400">
              {formatDistance(planet.distanceLy)}
            </span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.18em] text-signal-violet/90">
            {planet.classification}
            <span className="ml-1 text-slate-500">· DERIVED</span>
          </span>
          <span className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[10px] text-slate-300">
            <span>
              <span className="block text-[9px] uppercase tracking-[0.16em] text-slate-500">Radius</span>
              {planet.radiusEarth === null ? 'UNKNOWN' : formatRadius(planet.radiusEarth).split(' · ')[0]}
            </span>
            <span>
              <span className="block text-[9px] uppercase tracking-[0.16em] text-slate-500">Eq. Temp</span>
              {temperature === null ? 'UNKNOWN' : `${formatNumber(temperature, { digits: 0 })} K`}
            </span>
            <span className="truncate">
              <span className="block text-[9px] uppercase tracking-[0.16em] text-slate-500">Star</span>
              {planet.hostStarName}
            </span>
          </span>
          <span className="mt-1.5 flex items-center justify-between gap-2">
            <span className={`font-mono text-[9px] uppercase tracking-[0.16em] ${habitabilityTone(planet.habitability.level)}`}>
              {planet.habitability.label}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">
              {planet.isLive ? 'NASA ARCHIVE' : 'SNAPSHOT'}
            </span>
          </span>
        </span>
      </button>

      <div className="flex items-center justify-end gap-1 border-t border-signal-cyan/10 px-2 py-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleCompare(planet.id)
          }}
          disabled={compareDisabled && !isCompared}
          aria-pressed={isCompared}
          aria-label={isCompared ? `Remove ${planet.name} from comparison` : `Add ${planet.name} to comparison`}
          className="hud-button !px-2 !py-0.5 !text-[9px]"
        >
          {isCompared ? '■ COMPARING' : '□ COMPARE'}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleFavorite(planet.id)
          }}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Remove ${planet.name} from bookmarks` : `Bookmark ${planet.name}`}
          className={`hud-button !px-2 !py-0.5 !text-[9px] ${isFavorite ? '!text-signal-amber' : ''}`}
        >
          {isFavorite ? '★ SAVED' : '☆ SAVE'}
        </button>
      </div>
    </li>
  )
}

export default memo(PlanetCard)
