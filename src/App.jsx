import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import CosmicWeb from './components/CosmicWeb.jsx'
import MacroView from './components/MacroView.jsx'
import SkyView from './components/SkyView.jsx'
import SkyControls from './components/SkyControls.jsx'
import OrbitEngine from './components/OrbitEngine.jsx'
import PlanetScene from './components/PlanetScene.jsx'
import CameraRig from './components/CameraRig.jsx'
import HUD, { FILTERS, SORTS } from './components/HUD.jsx'
import LoadingSequence from './components/LoadingSequence.jsx'
import { getCatalogFacts, loadExoplanetCatalog } from './services/exoplanetApi.js'
import { DEFAULT_LOCATION, OBSERVER_LOCATIONS } from './services/skyPosition.js'

/**
 * ASTROVITA — application root.
 *
 * Owns every piece of UI state and the single catalog load. The data flow is:
 *
 *   exoplanetApi (TAP / cache / snapshot)
 *     -> dataNormalizer (one planet object + one StarSystem per host)
 *       -> App state (view machine, selection, filters, sort, favorites)
 *         -> MacroView | OrbitEngine + PlanetScene + CameraRig (WebGL)
 *         -> HUD (DOM overlay)
 *
 * NAVIGATION TIERS
 *   MACRO   every catalogued host star. Two projections of the same data:
 *             sky       the observer's real local sky, right now, 360 degrees
 *             galactic  a 3D cloud placed by RA/Dec/distance
 *   SYSTEM  one star system: its host star and that star's planets
 *   PLANET  a single world under close observation
 *
 * The tier lives in a useReducer machine rather than scattered booleans, so an
 * illegal combination (a selected planet with no selected system, say) is not
 * representable. Transitions are camera-driven: the reducer marks
 * isTransitioning, CameraRig runs the tween, and its onArrive callback
 * dispatches TRANSITION_END.
 *
 * Nothing inside the frame loop touches React state; the 3D layer exchanges
 * per-frame positions through a ref-held Map.
 */

/* ------------------------------------------------------------------ */
/* device / preference detection                                       */
/* ------------------------------------------------------------------ */

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  )
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (event) => setReduced(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])
  return reduced
}

/**
 * Coarse GPU-class guess. There is no reliable browser API for GPU tier, so
 * this combines the signals that correlate with weak graphics performance:
 * touch-first devices, few logical cores, low reported memory, small screens.
 * The result only lowers particle counts, pixel ratio and shader octaves; it
 * never removes information.
 */
function detectQuality() {
  if (typeof window === 'undefined') return 'high'
  const nav = window.navigator
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const cores = nav.hardwareConcurrency ?? 8
  const memory = nav.deviceMemory ?? 8
  const small = Math.min(window.innerWidth, window.innerHeight) < 700
  if ((coarse && small) || cores <= 4 || memory <= 4) return 'low'
  return 'high'
}

const QUALITY_PRESETS = {
  high: { stars: 18000, nebula: 1600, dpr: [1, 2], antialias: true, highDetail: true },
  // Weak GPUs get a thinner sky. The catalog itself is never reduced: this
  // trims decoration, never information.
  low: { stars: 6500, nebula: 700, dpr: [1, 1.5], antialias: false, highDetail: false },
}

/* ------------------------------------------------------------------ */
/* view state machine                                                  */
/* ------------------------------------------------------------------ */

const INITIAL_VIEW = {
  viewMode: 'MACRO',
  selectedSystem: null,
  selectedPlanet: null,
  isTransitioning: false,
  // True only while the camera is pulling back out to MACRO. Both MacroView and
  // OrbitEngine stay mounted for that window so the tiers cross-fade instead of
  // the system popping out of existence the instant the button is pressed.
  returningHome: false,
}

function viewReducer(state, action) {
  switch (action.type) {
    case 'SELECT_SYSTEM':
      if (!action.system) return state
      return {
        viewMode: 'SYSTEM',
        selectedSystem: action.system,
        // Re-entering a system clears any planet held from a previous visit.
        selectedPlanet: null,
        isTransitioning: true,
        returningHome: false,
      }

    case 'SELECT_PLANET': {
      if (!action.planet) return state
      // A planet always implies its system; selecting one from the catalog list
      // while in MACRO enters that system in the same dispatch.
      const system = action.system ?? state.selectedSystem
      if (!system) return state
      return {
        viewMode: 'PLANET',
        selectedSystem: system,
        selectedPlanet: action.planet,
        isTransitioning: true,
        returningHome: false,
      }
    }

    case 'BACK_TO_SYSTEM':
      if (!state.selectedSystem) return state
      return {
        ...state,
        viewMode: 'SYSTEM',
        selectedPlanet: null,
        isTransitioning: true,
        returningHome: false,
      }

    case 'RETURN_HOME':
      if (state.viewMode === 'MACRO') return state
      // The tier is NOT changed here. It flips to MACRO in TRANSITION_END, once
      // the zoom-out has actually finished.
      return { ...state, isTransitioning: true, returningHome: true }

    case 'TRANSITION_START':
      return { ...state, isTransitioning: true }

    case 'TRANSITION_END':
      if (state.returningHome) {
        return { ...INITIAL_VIEW }
      }
      return { ...state, isTransitioning: false }

    default:
      return state
  }
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

const STORAGE_KEYS = {
  favorites: 'astrovita.favorites.v1',
  observed: 'astrovita.observed.v1',
  badges: 'astrovita.badges.v1',
  audio: 'astrovita.audio.v1',
  location: 'astrovita.location.v1',
  projection: 'astrovita.projection.v1',
}

function readLocation() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.location)
    if (!raw) return DEFAULT_LOCATION
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed.name === 'string' &&
      Number.isFinite(parsed.latitude) &&
      Number.isFinite(parsed.longitude) &&
      Math.abs(parsed.latitude) <= 90 &&
      Math.abs(parsed.longitude) <= 180
    ) {
      return OBSERVER_LOCATIONS.find((l) => l.id === parsed.id) ?? parsed
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_LOCATION
}

function readSet(key) {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeSet(key, set) {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set)))
  } catch {
    /* storage unavailable: preferences simply do not persist */
  }
}

/* ------------------------------------------------------------------ */
/* explorer badges (game-like labels, not scientific claims)            */
/* ------------------------------------------------------------------ */

const BADGES = [
  {
    id: 'first-contact',
    title: 'FIRST CONTACT',
    body: 'You locked onto your first world. The catalog is open.',
    test: (planet, ctx) => ctx.observedCount === 1,
  },
  {
    id: 'red-world',
    title: 'RED WORLD',
    body: 'A planet around an M-type red dwarf, the most common kind of star in the galaxy.',
    // Spectral class M followed by a subtype digit or nothing ("M5.5V", "M").
    // Anchored so descriptive types like "Millisecond pulsar" cannot match.
    test: (planet) => typeof planet.hostStarType === 'string' && /^M(\d|\s|$)/.test(planet.hostStarType.trim()),
  },
  {
    id: 'ocean-candidate',
    title: 'OCEAN CANDIDATE',
    body: 'A world whose bulk properties allow a water-rich composition. Allowed, not confirmed.',
    test: (planet) =>
      planet.classificationTags.includes('Ocean World Candidate') || planet.classification === 'Hycean Candidate',
  },
  {
    id: 'hot-giant',
    title: 'HOT GIANT',
    body: 'A giant planet orbiting closer to its star than Mercury does to the Sun.',
    test: (planet) => planet.classification === 'Hot Jupiter' || planet.classification === 'Ultra-Hot Giant',
  },
  {
    id: 'nearby-world',
    title: 'NEARBY WORLD',
    body: 'Within 20 light years: close enough that its host star is a neighbour of the Sun.',
    test: (planet) => planet.distanceLy !== null && planet.distanceLy < 20,
  },
  {
    id: 'multi-planet',
    title: 'MULTI-PLANET SYSTEM',
    body: 'This star hosts at least four known planets.',
    test: (planet, ctx) => ctx.siblingCount >= 4 || (planet.planetsInSystem ?? 0) >= 4,
  },
  {
    id: 'extreme-world',
    title: 'EXTREME WORLD',
    body: 'Equilibrium temperature above 2000 K or below 150 K.',
    test: (planet) =>
      planet.equilibriumTemperatureK !== null &&
      (planet.equilibriumTemperatureK >= 2000 || planet.equilibriumTemperatureK <= 150),
  },
  {
    id: 'deep-field',
    title: 'DEEP FIELD',
    body: 'More than a thousand light years out. Its light left before the telescope was invented.',
    test: (planet) => planet.distanceLy !== null && planet.distanceLy > 1000,
  },
  {
    id: 'seven-worlds',
    title: 'SEVEN WORLDS',
    body: 'Seven worlds observed in this observatory.',
    test: (planet, ctx) => ctx.observedCount === 7,
  },
]

/* ------------------------------------------------------------------ */
/* audio: tiny synthesized UI cue, disabled by default                 */
/* ------------------------------------------------------------------ */

function createAudioCue() {
  let context = null
  return {
    play(frequency = 880, duration = 0.08) {
      try {
        if (!context) context = new (window.AudioContext || window.webkitAudioContext)()
        if (context.state === 'suspended') context.resume()
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.type = 'sine'
        osc.frequency.value = frequency
        gain.gain.setValueAtTime(0.0001, context.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration)
        osc.connect(gain).connect(context.destination)
        osc.start()
        osc.stop(context.currentTime + duration + 0.02)
      } catch {
        /* audio is optional */
      }
    },
    close() {
      if (context) {
        context.close().catch(() => {})
        context = null
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* scene wrapper                                                       */
/* ------------------------------------------------------------------ */

const LIGHT_DIRECTION = new THREE.Vector3(1, 0.35, 0.6).normalize()

function ObservatoryScene({
  view,
  starSystems,
  projection,
  location,
  bearingRef,
  skyActive,
  hoveredId,
  onHover,
  onSelectPlanet,
  onSelectSystem,
  onHoverSystem,
  cameraMode,
  positionsRef,
  reducedMotion,
  preset,
  autoRotate,
  resetToken,
  onArrive,
}) {
  const { viewMode, selectedSystem, selectedPlanet, returningHome } = view
  const observing = cameraMode === 'observation' || cameraMode === 'detail'

  const getSelectedPosition = useCallback(
    (out) => {
      if (!selectedPlanet) return null
      const p = positionsRef.current.get(selectedPlanet.id)
      if (!p) return null
      return out.copy(p)
    },
    [selectedPlanet, positionsRef],
  )

  // The macro cloud stays mounted through the whole return-home tween so the
  // two tiers cross-fade rather than the catalog popping in on arrival.
  const showMacro = viewMode === 'MACRO' || returningHome
  const showSystem = Boolean(selectedSystem)

  return (
    <>
      <ambientLight intensity={0.28} color="#8fb3ff" />
      <directionalLight
        position={[LIGHT_DIRECTION.x * 80, LIGHT_DIRECTION.y * 80, LIGHT_DIRECTION.z * 80]}
        intensity={viewMode === 'MACRO' ? 0.8 : 1.9}
        color="#fff4e0"
      />

      <CosmicWeb
        starCount={preset.stars}
        nebulaCount={preset.nebula}
        reducedMotion={reducedMotion}
        dim={observing ? 1 : 0}
      />

      {showMacro && projection === 'sky' && (
        <SkyView
          starSystems={starSystems}
          location={location}
          onSelectSystem={onSelectSystem}
          onHoverSystem={onHoverSystem}
          selectedHostname={selectedSystem?.hostname ?? null}
          bearingRef={bearingRef}
          active={skyActive}
          reducedMotion={reducedMotion}
        />
      )}

      {showMacro && projection === 'galactic' && (
        <MacroView
          starSystems={starSystems}
          onSelectSystem={onSelectSystem}
          onHoverSystem={onHoverSystem}
          selectedHostname={selectedSystem?.hostname ?? null}
          positionsRef={positionsRef}
          reducedMotion={reducedMotion}
        />
      )}

      {showSystem && (
        <OrbitEngine
          // Remounting on a system change resets orbital phase and the body
          // registry cleanly instead of leaking the previous system's refs.
          key={selectedSystem.hostname}
          starSystem={selectedSystem}
          selectedId={selectedPlanet?.id ?? null}
          hoveredId={hoveredId}
          onHover={onHover}
          onSelect={onSelectPlanet}
          paused={observing}
          reducedMotion={reducedMotion}
          dimOthers={observing}
          positionsRef={positionsRef}
        />
      )}

      {showSystem && selectedPlanet && (
        <PlanetScene
          planet={selectedPlanet}
          getPosition={getSelectedPosition}
          targetScale={observing ? 1.7 : 0.95}
          autoRotate={autoRotate}
          reducedMotion={reducedMotion}
          highDetail={preset.highDetail}
          showLock
        />
      )}

      <CameraRig
        mode={cameraMode}
        targetId={selectedPlanet?.id ?? null}
        positionsRef={positionsRef}
        reducedMotion={reducedMotion}
        resetToken={resetToken}
        onArrive={onArrive}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* root                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const reducedMotion = usePrefersReducedMotion()
  const [quality] = useState(detectQuality)
  const preset = QUALITY_PRESETS[quality]

  // catalog
  const [catalog, setCatalog] = useState([])
  const [starSystems, setStarSystems] = useState(() => new Map())
  const [dataMeta, setDataMeta] = useState(null)
  const [loadStage, setLoadStage] = useState('')
  const [catalogReady, setCatalogReady] = useState(false)

  // navigation
  const [entered, setEntered] = useState(false)
  const [view, dispatch] = useReducer(viewReducer, INITIAL_VIEW)
  const [hoveredId, setHoveredId] = useState(null)
  const [hoveredSystem, setHoveredSystem] = useState(null)

  // sky portal
  const [location, setLocation] = useState(readLocation)
  const [projection, setProjection] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEYS.projection) === 'galactic' ? 'galactic' : 'sky'
    } catch {
      return 'sky'
    }
  })
  // Written by SkyView every frame, sampled by the DOM readout at 10 Hz.
  const bearingRef = useRef({ azimuth: 0, altitude: 0 })
  const [resetToken, setResetToken] = useState(0)
  const [autoRotate, setAutoRotate] = useState(true)
  const [immersive, setImmersive] = useState(false)

  // catalog controls
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState(() => new Set())
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const [sort, setSort] = useState('distance')

  // persistence-backed
  const [favorites, setFavorites] = useState(() => readSet(STORAGE_KEYS.favorites))
  const [observed, setObserved] = useState(() => readSet(STORAGE_KEYS.observed))
  const [earnedBadges, setEarnedBadges] = useState(() => readSet(STORAGE_KEYS.badges))
  const [audioEnabled, setAudioEnabled] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEYS.audio) === '1'
    } catch {
      return false
    }
  })

  // compare
  const [compareIds, setCompareIds] = useState([])
  const [compareOpen, setCompareOpen] = useState(false)

  // toasts
  const [badgeToast, setBadgeToast] = useState(null)
  const [factToast, setFactToast] = useState(null)
  const factCounter = useRef(0)

  const positionsRef = useRef(new Map())
  const searchInputRef = useRef(null)
  const audioRef = useRef(null)

  /* ---------------- catalog load ---------------- */

  useEffect(() => {
    const controller = new AbortController()
    let mounted = true

    loadExoplanetCatalog({
      signal: controller.signal,
      onStage: (stage) => mounted && setLoadStage(stage),
    })
      .then(({ planets, starSystems: systems, meta }) => {
        if (!mounted) return
        setCatalog(planets)
        setStarSystems(systems)
        setDataMeta(meta)
        setCatalogReady(true)
      })
      .catch(() => {
        // Only an abort reaches here; the service resolves on every data error.
      })

    return () => {
      mounted = false
      controller.abort()
    }
  }, [])

  /* ---------------- persistence ---------------- */

  useEffect(() => writeSet(STORAGE_KEYS.favorites, favorites), [favorites])
  useEffect(() => writeSet(STORAGE_KEYS.observed, observed), [observed])
  useEffect(() => writeSet(STORAGE_KEYS.badges, earnedBadges), [earnedBadges])
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.location, JSON.stringify(location))
    } catch {
      /* ignore */
    }
  }, [location])
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.projection, projection)
    } catch {
      /* ignore */
    }
  }, [projection])
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.audio, audioEnabled ? '1' : '0')
    } catch {
      /* ignore */
    }
    if (audioEnabled && !audioRef.current) audioRef.current = createAudioCue()
    if (!audioEnabled && audioRef.current) {
      audioRef.current.close()
      audioRef.current = null
    }
  }, [audioEnabled])

  useEffect(() => () => audioRef.current?.close(), [])

  /* ---------------- derived catalog ---------------- */

  const catalogById = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog])

  const filteredPlanets = useMemo(() => {
    const query = search.trim().toLowerCase()
    const activeFilters = FILTERS.filter((f) => filters.has(f.id))
    const sorter = SORTS.find((s) => s.id === sort) ?? SORTS[0]

    const list = catalog.filter((planet) => {
      if (showFavoritesOnly && !favorites.has(planet.id)) return false
      if (activeFilters.some((f) => !f.test(planet))) return false
      if (!query) return true
      return (
        planet.name.toLowerCase().includes(query) ||
        planet.hostStarName.toLowerCase().includes(query) ||
        planet.classification.toLowerCase().includes(query) ||
        planet.classificationTags.some((tag) => tag.toLowerCase().includes(query))
      )
    })

    // Unknown values always sort last, regardless of direction.
    list.sort((a, b) => {
      const ka = sorter.key(a)
      const kb = sorter.key(b)
      if (ka === null || ka === undefined) return 1
      if (kb === null || kb === undefined) return -1
      if (typeof ka === 'string') return ka.localeCompare(kb)
      return sorter.descending ? kb - ka : ka - kb
    })
    return list
  }, [catalog, search, filters, showFavoritesOnly, favorites, sort])

  const { selectedPlanet, selectedSystem, viewMode, isTransitioning } = view
  const selectedId = selectedPlanet?.id ?? null

  const comparePlanets = useMemo(
    () => compareIds.map((id) => catalogById.get(id)).filter(Boolean),
    [compareIds, catalogById],
  )

  /* ---------------- actions ---------------- */

  const playCue = useCallback(
    (frequency) => {
      if (audioEnabled && audioRef.current) audioRef.current.play(frequency)
    },
    [audioEnabled],
  )

  /**
   * Enter a star system from the macro cloud.
   * Defined here, outside JSX, so R3F mesh props never receive a fresh closure
   * identity on every render.
   */
  const selectSystem = useCallback(
    (system) => {
      if (!system) return
      dispatch({ type: 'SELECT_SYSTEM', system })
      setCompareOpen(false)
      playCue(520)
    },
    [playCue],
  )

  const returnHome = useCallback(() => {
    dispatch({ type: 'RETURN_HOME' })
    playCue(392)
  }, [playCue])

  const backToSystem = useCallback(() => {
    dispatch({ type: 'BACK_TO_SYSTEM' })
    playCue(440)
  }, [playCue])

  const selectPlanet = useCallback(
    (id) => {
      const planet = catalogById.get(id)
      if (!planet) return

      // Selecting from the catalog list while in MACRO enters the planet's
      // system in the same dispatch, so the tiers can never disagree.
      const system = starSystems.get(planet.hostStarName) ?? selectedSystem
      dispatch({ type: 'SELECT_PLANET', planet, system })
      setCompareOpen(false)
      playCue(660)

      if (observed.has(id)) return

      const nextObserved = new Set(observed)
      nextObserved.add(id)
      setObserved(nextObserved)

      // Badge evaluation uses the post-update count.
      const siblingCount = system?.planets.length ?? 1
      const ctx = { observedCount: nextObserved.size, siblingCount }
      const fresh = BADGES.find((b) => !earnedBadges.has(b.id) && b.test(planet, ctx))
      if (fresh) {
        setEarnedBadges((prev) => new Set(prev).add(fresh.id))
        setBadgeToast(fresh)
      }

      // A curiosity prompt every fourth new world.
      factCounter.current += 1
      if (factCounter.current % 4 === 0) {
        const facts = getCatalogFacts()
        if (facts.length) setFactToast(facts[Math.floor(Math.random() * facts.length)])
      }
    },
    [catalogById, starSystems, selectedSystem, observed, earnedBadges, playCue],
  )

  const exitObservation = backToSystem

  const discoverWorld = useCallback(() => {
    if (!catalog.length) return
    // "Interesting" = habitable-zone candidate, detected atmosphere, or extreme.
    const pool = catalog.filter(
      (p) =>
        p.id !== selectedId &&
        (p.habitability.level >= 3 ||
          p.atmosphere?.status === 'DETECTED' ||
          p.classification === 'Ultra-Hot Giant' ||
          p.classificationTags.includes('Cryogenic') ||
          p.highlights.length > 0),
    )
    const source = pool.length ? pool : catalog.filter((p) => p.id !== selectedId)
    if (!source.length) return
    selectPlanet(source[Math.floor(Math.random() * source.length)].id)
  }, [catalog, selectedId, selectPlanet])

  const focusSelected = useCallback(() => {
    if (!selectedId) return
    setResetToken((n) => n + 1)
  }, [selectedId])

  const resetCamera = useCallback(() => {
    setResetToken((n) => n + 1)
  }, [])

  const toggleFilter = useCallback((id) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleFavorite = useCallback((id) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleCompare = useCallback((id) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 3) return prev
      return [...prev, id]
    })
  }, [])

  const removeCompare = useCallback((id) => {
    setCompareIds((prev) => prev.filter((x) => x !== id))
  }, [])

  const stepSelection = useCallback(
    (direction) => {
      if (!filteredPlanets.length) return
      const index = filteredPlanets.findIndex((p) => p.id === selectedId)
      const nextIndex =
        index === -1
          ? 0
          : (index + direction + filteredPlanets.length) % filteredPlanets.length
      selectPlanet(filteredPlanets[nextIndex].id)
    },
    [filteredPlanets, selectedId, selectPlanet],
  )

  // CameraRig calls this when a tween completes. It is the ONLY thing that
  // clears isTransitioning, which is what keeps the "Regresar a Casa" button
  // disabled for exactly as long as the camera is actually moving.
  const onArrive = useCallback(() => {
    dispatch({ type: 'TRANSITION_END' })
  }, [])

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    if (!entered) return undefined
    const handler = (event) => {
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')

      if (event.key === 'Escape') {
        // Escape walks back up the tiers one step at a time.
        if (compareOpen) setCompareOpen(false)
        else if (typing) target.blur()
        else if (viewMode === 'PLANET') backToSystem()
        else if (viewMode === 'SYSTEM') returnHome()
        return
      }
      if (typing) return

      switch (event.key) {
        case '/':
          event.preventDefault()
          searchInputRef.current?.focus()
          break
        case 'r':
        case 'R':
          discoverWorld()
          break
        case 'i':
        case 'I':
          setImmersive((v) => !v)
          break
        case 'h':
        case 'H':
          returnHome()
          break
        case 'Enter':
          focusSelected()
          break
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault()
          stepSelection(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault()
          stepSelection(-1)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    entered,
    compareOpen,
    viewMode,
    backToSystem,
    returnHome,
    discoverWorld,
    focusSelected,
    stepSelection,
  ])

  /* ---------------- toast timers ---------------- */

  useEffect(() => {
    if (!badgeToast) return undefined
    const id = setTimeout(() => setBadgeToast(null), 9000)
    return () => clearTimeout(id)
  }, [badgeToast])

  useEffect(() => {
    if (!factToast) return undefined
    const id = setTimeout(() => setFactToast(null), 14000)
    return () => clearTimeout(id)
  }, [factToast])

  /* ---------------- render ---------------- */

  // The camera tier is derived, never stored: one source of truth (the view
  // machine) drives both what is rendered and where the camera goes.
  const cameraMode = !entered
    ? 'intro'
    : view.returningHome || viewMode === 'MACRO'
      ? projection === 'sky'
        ? 'sky'
        : 'macro'
      : viewMode === 'PLANET' && selectedPlanet
        ? 'observation'
        : 'system'

  // HUD internals still speak the older two-value vocabulary; map rather than
  // rewrite 900 lines of panel code for a rename.
  const hudMode = viewMode === 'PLANET' ? 'observation' : 'universe'

  // SkyView owns the camera only when the portal is settled: never during a
  // tween, never once a system is being entered.
  const skyActive = entered && viewMode === 'MACRO' && !isTransitioning && !view.returningHome

  const toggleProjection = useCallback(() => {
    setProjection((p) => (p === 'sky' ? 'galactic' : 'sky'))
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-void-900">
      <Canvas
        dpr={preset.dpr}
        camera={{ fov: 50, near: 0.1, far: 4000, position: [0, 96, 250] }}
        gl={{
          antialias: preset.antialias,
          powerPreference: 'high-performance',
          alpha: false,
          stencil: false,
        }}
        onPointerMissed={() => setHoveredId(null)}
        aria-label="ASTROVITA three-dimensional exoplanet field"
        role="img"
      >
        <Suspense fallback={null}>
          <ObservatoryScene
            view={view}
            starSystems={starSystems}
            projection={projection}
            location={location}
            bearingRef={bearingRef}
            skyActive={skyActive}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            onSelectPlanet={selectPlanet}
            onSelectSystem={selectSystem}
            onHoverSystem={setHoveredSystem}
            cameraMode={cameraMode}
            positionsRef={positionsRef}
            reducedMotion={reducedMotion}
            preset={preset}
            autoRotate={autoRotate}
            resetToken={resetToken}
            onArrive={onArrive}
          />
        </Suspense>
      </Canvas>

      {!entered && (
        <LoadingSequence
          stage={loadStage}
          ready={catalogReady}
          dataMeta={dataMeta}
          reducedMotion={reducedMotion}
          onEnter={() => {
            setEntered(true)
            playCue(520)
          }}
        />
      )}

      {entered && (
        <HUD
          planets={filteredPlanets}
          totalCount={catalog.length}
          visibleCount={selectedSystem ? selectedSystem.planets.length : starSystems.size}
          dataMeta={dataMeta}
          mode={hudMode}
          viewMode={viewMode}
          isTransitioning={isTransitioning}
          onReturnHome={returnHome}
          selectedSystem={selectedSystem}
          hoveredSystem={hoveredSystem}
          selectedPlanet={selectedPlanet}
          hoveredId={hoveredId}
          favorites={favorites}
          compareIds={compareIds}
          comparePlanets={comparePlanets}
          observedCount={observed.size}
          search={search}
          onSearchChange={setSearch}
          filters={filters}
          onToggleFilter={toggleFilter}
          showFavoritesOnly={showFavoritesOnly}
          onToggleFavoritesOnly={() => setShowFavoritesOnly((v) => !v)}
          sort={sort}
          onSortChange={setSort}
          onSelect={selectPlanet}
          onHover={setHoveredId}
          onToggleFavorite={toggleFavorite}
          onToggleCompare={toggleCompare}
          onRemoveCompare={removeCompare}
          onDiscover={discoverWorld}
          onFocus={focusSelected}
          onReset={resetCamera}
          onExitObservation={exitObservation}
          autoRotate={autoRotate}
          onToggleAutoRotate={() => setAutoRotate((v) => !v)}
          immersive={immersive}
          onToggleImmersive={() => setImmersive((v) => !v)}
          audioEnabled={audioEnabled}
          onToggleAudio={() => setAudioEnabled((v) => !v)}
          compareOpen={compareOpen}
          onToggleCompareOpen={() => setCompareOpen((v) => !v)}
          badgeToast={badgeToast}
          onDismissBadge={() => setBadgeToast(null)}
          factToast={factToast}
          onDismissFact={() => setFactToast(null)}
          reducedMotion={reducedMotion}
          searchInputRef={searchInputRef}
        />
      )}

      {entered && viewMode === 'MACRO' && (
        <SkyControls
          location={location}
          onChangeLocation={setLocation}
          bearingRef={bearingRef}
          systemCount={starSystems.size}
          planetCount={catalog.length}
          projection={projection}
          onToggleProjection={toggleProjection}
          hidden={immersive}
        />
      )}

      {/* Persistent scale disclaimer, visible in every mode including immersive. */}
      {entered && (
        <p className="pointer-events-none absolute bottom-0.5 left-2 right-2 z-30 truncate font-mono text-[7px] uppercase tracking-[0.16em] text-slate-600 sm:bottom-1 sm:left-3 sm:right-auto sm:text-[8px] sm:tracking-[0.18em]">
          Visualized orbit scale · surface &amp; atmosphere: artistic model · measurements: {dataMeta?.source ?? 'pending'}
        </p>
      )}
    </div>
  )
}
