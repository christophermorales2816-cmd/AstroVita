import { useEffect, useRef, useState } from 'react'
import { formatLatLon, OBSERVER_LOCATIONS } from '../services/skyPosition.js'

/**
 * FILE: src/components/SkyControls.jsx
 *
 * PURPOSE
 *   DOM overlay for the sky portal: where the observer is standing, where the
 *   telescope is pointing, how many systems are in the catalog, and a switch
 *   between the local-sky and galactic projections.
 *
 * DEPENDENCIES
 *   ../services/skyPosition.js  OBSERVER_LOCATIONS, formatLatLon
 *
 * PERFORMANCE-CRITICAL DECISIONS
 *   - The bearing readout does NOT subscribe to React state from the frame
 *     loop. SkyView writes the current bearing into a ref every frame; this
 *     component samples that ref on a 100 ms interval and renders ten times a
 *     second. A 60 Hz setState here would re-render the whole overlay tree.
 */

function BearingReadout({ bearingRef }) {
  const [bearing, setBearing] = useState({ azimuth: 0, altitude: 0 })

  useEffect(() => {
    const id = setInterval(() => {
      const b = bearingRef?.current
      if (!b) return
      setBearing((prev) =>
        Math.abs(prev.azimuth - b.azimuth) > 0.005 || Math.abs(prev.altitude - b.altitude) > 0.005
          ? { azimuth: b.azimuth, altitude: b.altitude }
          : prev,
      )
    }, 100)
    return () => clearInterval(id)
  }, [bearingRef])

  return (
    <div
      className="pointer-events-none select-none font-mono"
      role="status"
      aria-live="off"
      aria-label={`Telescope bearing azimuth ${bearing.azimuth.toFixed(1)} degrees, altitude ${bearing.altitude.toFixed(1)} degrees`}
    >
      <div className="hud-label">Telescope bearing</div>
      <div className="mt-1 text-[13px] text-slate-200">
        <span className="text-slate-500">↔</span> {bearing.azimuth.toFixed(2).padStart(6, '0')}°
      </div>
      <div className="text-[13px] text-slate-200">
        <span className="text-slate-500">↕</span> {bearing.altitude.toFixed(2).padStart(5, '0')}°
      </div>
    </div>
  )
}

function LocationPicker({ location, onChangeLocation }) {
  const [open, setOpen] = useState(false)
  const [geoError, setGeoError] = useState(null)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const useMyLocation = () => {
    setGeoError(null)
    if (!navigator.geolocation) {
      setGeoError('Geolocation not available in this browser')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChangeLocation({
          id: 'custom',
          name: 'Mi ubicación',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        })
        setOpen(false)
      },
      () => setGeoError('Location permission denied'),
      { timeout: 8000, maximumAge: 600000 },
    )
  }

  return (
    <div ref={rootRef} className="pointer-events-auto relative flex items-center gap-3">
      <span className="font-mono text-[12px] text-slate-300">
        {location.name} · {formatLatLon(location.latitude, location.longitude)}
      </span>
      <button
        type="button"
        className="hud-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Change location
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Observer location"
          className="glass-panel panel-scroll absolute bottom-full left-0 mb-2 max-h-[52vh] w-64 overflow-y-auto py-1"
        >
          <button
            type="button"
            role="option"
            aria-selected={location.id === 'custom'}
            onClick={useMyLocation}
            className="block w-full px-4 py-2 text-left font-mono text-[12px] uppercase tracking-[0.16em] text-signal-cyan hover:bg-signal-cyan/10"
          >
            Use my location
          </button>
          {geoError && (
            <div className="px-4 pb-2 font-mono text-[10px] text-signal-red/80">{geoError}</div>
          )}
          <div className="hud-divider my-1" />
          {OBSERVER_LOCATIONS.map((loc) => (
            <button
              key={loc.id}
              type="button"
              role="option"
              aria-selected={loc.id === location.id}
              onClick={() => {
                onChangeLocation(loc)
                setOpen(false)
              }}
              className={`block w-full px-4 py-2 text-left text-[13px] hover:bg-white/5 ${
                loc.id === location.id ? 'text-signal-cyan' : 'text-slate-200'
              }`}
            >
              {loc.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * @param {object} props
 * @param {object} props.location
 * @param {(loc: object) => void} props.onChangeLocation
 * @param {React.MutableRefObject} props.bearingRef
 * @param {number} props.systemCount
 * @param {number} props.planetCount
 * @param {'sky'|'galactic'} props.projection
 * @param {() => void} props.onToggleProjection
 * @param {boolean} props.hidden
 */
export default function SkyControls({
  location,
  onChangeLocation,
  bearingRef,
  systemCount,
  planetCount,
  projection,
  onToggleProjection,
  hidden = false,
}) {
  if (hidden) return null
  const sky = projection === 'sky'

  return (
    <div className="pointer-events-none absolute inset-0 z-30 select-none">
      {/* Bearing, top-left, under the top bar. */}
      {sky && (
        <div className="absolute left-4 top-24 sm:left-6">
          <BearingReadout bearingRef={bearingRef} />
        </div>
      )}

      {/* Projection switch, right side. */}
      <div className="pointer-events-auto absolute right-4 top-24 sm:right-6">
        <button
          type="button"
          className="hud-button"
          onClick={onToggleProjection}
          aria-pressed={!sky}
          aria-label={sky ? 'Switch to galactic projection' : 'Switch to local sky'}
          title={sky ? 'Ver el catálogo en 3D' : 'Ver el cielo desde tu ubicación'}
        >
          {sky ? 'Galactic view' : 'Local sky'}
        </button>
      </div>

      {/* Location, bottom-left. */}
      {sky && (
        <div className="absolute bottom-10 left-4 sm:bottom-12 sm:left-6">
          <LocationPicker location={location} onChangeLocation={onChangeLocation} />
        </div>
      )}

      {/* Catalog size, bottom-right. */}
      <div className="absolute bottom-10 right-4 text-right font-mono sm:bottom-12 sm:right-6">
        <div className="text-[13px] text-slate-400">
          {new Intl.NumberFormat('en-US').format(systemCount)} <span className="text-slate-600">systems</span>
        </div>
        <div className="text-[11px] text-slate-600">
          {new Intl.NumberFormat('en-US').format(planetCount)} planets
        </div>
      </div>
    </div>
  )
}
