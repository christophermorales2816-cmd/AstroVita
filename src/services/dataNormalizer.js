/**
 * ASTROVITA — data normalization layer.
 *
 * Everything that turns a raw catalog row (NASA Exoplanet Archive TAP JSON, or
 * an entry from the bundled offline snapshot) into the single object shape the
 * rest of the application consumes lives here.
 *
 * Two hard rules govern this file:
 *
 *   1. A value that is missing upstream stays missing. It is normalized to
 *      `null` and rendered as UNKNOWN / NOT AVAILABLE. Nothing is estimated,
 *      interpolated or invented to fill a gap.
 *   2. Anything this file *computes* (classification, habitability wording,
 *      colour palettes, visual radii) is tagged as DERIVED or ARTISTIC MODEL so
 *      the UI can label it and never present it as a measurement.
 */

/** Parsecs to light years. IAU definition. */
export const PC_TO_LY = 3.2615637769

/** Earth radii per Jupiter radius, used only for display conversions. */
export const RJUP_IN_REARTH = 11.2089

/** Earth masses per Jupiter mass, used only for display conversions. */
export const MJUP_IN_MEARTH = 317.828

export const UNKNOWN = 'UNKNOWN'
export const NOT_AVAILABLE = 'NOT AVAILABLE'

/** Provenance tags shown next to values in the HUD. */
export const PROVENANCE = {
  MEASURED: 'MEASURED',
  ESTIMATED: 'ESTIMATED',
  DERIVED: 'DERIVED',
  ARTISTIC: 'ARTISTIC MODEL',
  UNAVAILABLE: 'UNAVAILABLE',
}

/** Visual surface profiles consumed by the GLSL surface shader as an int. */
export const SURFACE_PROFILE = {
  ROCKY: 0,
  OCEAN: 1,
  GAS_GIANT: 2,
  HOT_JUPITER: 3,
  ICE: 4,
  LAVA: 5,
  HYCEAN: 6,
  TIDAL_ROCK: 7,
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Coerce an arbitrary upstream value to a finite number, or null.
 * Archive rows deliver numbers, numeric strings, nulls and empty strings
 * interchangeably depending on the output format.
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

/** Coerce to a trimmed non-empty string, or null. */
export function toText(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s.length ? s : null
}

/** Stable, URL-safe id derived from a planet name. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/\+/g, '-plus-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Deterministic 32-bit hash. Used to give each planet a stable shader seed. */
export function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

/** '#rrggbb' -> [r, g, b] in 0..1, for shader uniforms. */
export function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  const int = parseInt(clean, 16)
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255]
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Format a number for the HUD without ever printing a fabricated value.
 * Returns the UNKNOWN sentinel when the input is null.
 */
export function formatNumber(value, { digits = 2, unit = '', compact = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN
  let text
  if (compact && Math.abs(value) >= 10000) {
    text = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    )
  } else if (Math.abs(value) >= 1000) {
    text = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
  } else {
    text = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(value)
  }
  return unit ? `${text} ${unit}` : text
}

export function formatDistance(ly) {
  if (ly === null) return UNKNOWN
  if (ly < 100) return `${formatNumber(ly, { digits: 2 })} LY`
  return `${formatNumber(ly, { digits: 0 })} LY`
}

export function formatPeriod(days) {
  if (days === null) return UNKNOWN
  if (days < 1) return `${formatNumber(days * 24, { digits: 1 })} H`
  if (days > 1000) return `${formatNumber(days / 365.25, { digits: 1 })} YR`
  return `${formatNumber(days, { digits: days < 10 ? 3 : 1 })} D`
}

export function formatRadius(rEarth) {
  if (rEarth === null) return UNKNOWN
  if (rEarth >= 6) {
    return `${formatNumber(rEarth, { digits: 1 })} R⊕ · ${formatNumber(rEarth / RJUP_IN_REARTH, {
      digits: 2,
    })} R♃`
  }
  return `${formatNumber(rEarth, { digits: 2 })} R⊕`
}

export function formatMass(mEarth, isMinimum) {
  if (mEarth === null) return UNKNOWN
  const prefix = isMinimum ? '≥ ' : ''
  if (mEarth >= 50) {
    return `${prefix}${formatNumber(mEarth, { digits: 0 })} M⊕ · ${formatNumber(
      mEarth / MJUP_IN_MEARTH,
      { digits: 2 },
    )} M♃`
  }
  return `${prefix}${formatNumber(mEarth, { digits: 2 })} M⊕`
}

export function formatTemperature(kelvin) {
  if (kelvin === null) return UNKNOWN
  const celsius = kelvin - 273.15
  return `${formatNumber(kelvin, { digits: 0 })} K · ${formatNumber(celsius, { digits: 0 })} °C`
}

/* ------------------------------------------------------------------ */
/* derived science                                                     */
/* ------------------------------------------------------------------ */

/**
 * Bulk density in g/cm3, derived from radius and mass when both are measured.
 * Returned as DERIVED — it is arithmetic on two measurements, not an
 * independent observation.
 */
export function deriveDensity(radiusEarth, massEarth) {
  if (radiusEarth === null || massEarth === null || radiusEarth <= 0) return null
  // Earth: 5.513 g/cm3. density scales as M / R^3 in Earth units.
  return 5.513 * (massEarth / Math.pow(radiusEarth, 3))
}

/**
 * Insolation relative to Earth, derived from stellar radius, stellar effective
 * temperature and the orbital semi-major axis via the Stefan-Boltzmann law.
 * Null unless all three inputs are present.
 */
export function deriveInsolation(starRadiusSolar, starTeffK, semiMajorAxisAu) {
  if (starRadiusSolar === null || starTeffK === null || semiMajorAxisAu === null) return null
  if (semiMajorAxisAu <= 0) return null
  const lumSolar = Math.pow(starRadiusSolar, 2) * Math.pow(starTeffK / 5772, 4)
  return lumSolar / Math.pow(semiMajorAxisAu, 2)
}

/**
 * Tidal locking is not a catalog measurement. This is a coarse expectation
 * based on a close orbit around a small, cool star, and must be labelled
 * DERIVED wherever it is shown.
 */
export function deriveTidalLockCandidate(planet) {
  const { semiMajorAxisAu, orbitalPeriodDays, hostStarTemperatureK } = planet
  const coolHost = hostStarTemperatureK !== null && hostStarTemperatureK < 4800
  if (semiMajorAxisAu !== null && semiMajorAxisAu < 0.1 && coolHost) return true
  if (semiMajorAxisAu !== null && semiMajorAxisAu < 0.05) return true
  if (semiMajorAxisAu === null && orbitalPeriodDays !== null && orbitalPeriodDays < 10 && coolHost) {
    return true
  }
  return false
}

/**
 * Classification derived from measured radius, mass and equilibrium
 * temperature. These are visualization categories — only a few of them
 * (for example "Hot Jupiter") correspond to widely used astronomical terms,
 * and none of them is an official IAU designation.
 */
export function classifyPlanet(planet) {
  const r = planet.radiusEarth
  const m = planet.massEarth
  const t = planet.equilibriumTemperatureK
  const tags = []

  let primary = 'Unclassified'

  if (r === null && m === null) {
    primary = 'Insufficient Data'
  } else if (r === null) {
    // Mass-only object (typically radial velocity or imaging).
    if (m >= 100) primary = 'Gas Giant'
    else if (m >= 20) primary = 'Neptunian'
    else if (m >= 6) primary = 'Sub-Neptune'
    else if (m >= 2) primary = 'Super-Earth'
    else primary = 'Terrestrial'
    tags.push('Radius Unmeasured')
  } else if (r >= 9) {
    if (t !== null && t >= 2200) primary = 'Ultra-Hot Giant'
    else if (t !== null && t >= 1000) primary = 'Hot Jupiter'
    else primary = 'Gas Giant'
  } else if (r >= 5.5) {
    primary = t !== null && t >= 1000 ? 'Hot Neptune' : 'Neptunian'
  } else if (r >= 2.5) {
    if (t !== null && t >= 180 && t <= 320) primary = 'Hycean Candidate'
    else primary = 'Sub-Neptune'
  } else if (r >= 1.8) {
    primary = 'Mini-Neptune'
  } else if (r >= 1.25) {
    primary = 'Super-Earth'
  } else {
    primary = 'Terrestrial'
  }

  const density = deriveDensity(r, m)
  if (density !== null && density > 5.0 && r !== null && r < 2.2) tags.push('Dense Rocky')
  if (density !== null && density < 1.0 && r !== null && r > 6) tags.push('Low Density Giant')

  if (t !== null && t >= 180 && t <= 310 && r !== null && r <= 1.8) {
    tags.push('Temperate Rocky Candidate')
  }
  if (t !== null && t >= 250 && t <= 320 && r !== null && r > 1.8 && r <= 3.2) {
    tags.push('Ocean World Candidate')
  }
  if (t !== null && t >= 1500) tags.push('Extreme Irradiation')
  if (t !== null && t <= 150) tags.push('Cryogenic')
  if (deriveTidalLockCandidate(planet)) tags.push('Tidally Locked Candidate')
  if (planet.discoveryMethod === 'Imaging') tags.push('Directly Imaged')
  if (planet.massIsMinimum) tags.push('Minimum Mass Only')

  return { primary, tags }
}

/**
 * Habitability wording. Deliberately conservative: this describes orbital and
 * bulk-property plausibility only. It is never a statement about life, and the
 * UI must not render it as one.
 */
export function deriveHabitability(planet) {
  const t = planet.equilibriumTemperatureK
  const r = planet.radiusEarth

  if (t === null) {
    return {
      level: 0,
      label: 'INSUFFICIENT DATA',
      detail: 'No equilibrium temperature available, so no habitability assessment is possible.',
    }
  }

  const temperate = t >= 180 && t <= 310
  const rockySize = r === null ? null : r <= 1.8

  if (temperate && rockySize === true) {
    return {
      level: 3,
      label: 'HABITABLE ZONE CANDIDATE',
      detail:
        'Temperature and radius are compatible with a rocky world where liquid water could be stable. Nothing is known about whether it has an atmosphere or water.',
    }
  }
  if (temperate && rockySize === null) {
    return {
      level: 2,
      label: 'TEMPERATE WORLD · RADIUS UNKNOWN',
      detail:
        'Equilibrium temperature is temperate, but no radius measurement exists, so the bulk composition is unconstrained.',
    }
  }
  if (temperate && r !== null && r <= 3.2) {
    return {
      level: 2,
      label: 'ATMOSPHERIC INTEREST',
      detail:
        'Temperate but too large to be rocky. Likely a volatile-rich sub-Neptune; a Hycean interpretation is hypothetical.',
    }
  }
  if (temperate) {
    return {
      level: 1,
      label: 'TEMPERATE GIANT',
      detail: 'Temperate irradiation, but a giant planet with no plausible surface.',
    }
  }
  if (t > 310 && t < 600) {
    return { level: 1, label: 'WARM WORLD', detail: 'Hotter than the conventional habitable zone.' }
  }
  if (t >= 600) {
    return {
      level: 0,
      label: 'EXTREME ENVIRONMENT',
      detail: 'Far too hot for liquid water at any plausible surface pressure.',
    }
  }
  return {
    level: 0,
    label: 'FROZEN ENVIRONMENT',
    detail: 'Below the temperature range where surface liquid water is expected to be stable.',
  }
}

/**
 * Biosignature status. There is no confirmed biosignature detection on any
 * exoplanet, so this function is intentionally incapable of returning one.
 */
export function deriveBiosignatureStatus() {
  return 'NOT CONFIRMED'
}

/* ------------------------------------------------------------------ */
/* visualization palette (ARTISTIC MODEL — not observed appearance)     */
/* ------------------------------------------------------------------ */

const SPECIES_TINTS = [
  { match: /ch4|methane/i, glow: '#3fe6d4', accent: '#1f8f86' },
  { match: /h2o|water/i, glow: '#8fc4ff', accent: '#dbe9ff' },
  { match: /so2|sulf|sulph/i, glow: '#ffc75a', accent: '#ffe9a8' },
  { match: /co2|carbon diox/i, glow: '#ff8e5e', accent: '#ffd0b0' },
  { match: /^h$|^h2$|hydrogen/i, glow: '#a9c9ff', accent: '#e3ecff' },
  { match: /fe|ti|mg|sio|metal/i, glow: '#ffd08a', accent: '#fff0cf' },
  { match: /na|k\b|sodium|potassium/i, glow: '#ffb26b', accent: '#ffe0bf' },
  { match: /n2|nitrogen/i, glow: '#9fd8ff', accent: '#e6f5ff' },
  { match: /co\b/i, glow: '#c9b6ff', accent: '#ece5ff' },
]

const BASE_PALETTES = {
  [SURFACE_PROFILE.ROCKY]: {
    low: '#241a15',
    mid: '#6b4a35',
    high: '#c4a184',
    accent: '#ffd9b5',
    glow: '#d29a6a',
  },
  [SURFACE_PROFILE.OCEAN]: {
    low: '#031d3d',
    mid: '#0b6a9c',
    high: '#5fd7e8',
    accent: '#e9fbff',
    glow: '#6fd9ff',
  },
  [SURFACE_PROFILE.GAS_GIANT]: {
    low: '#23304f',
    mid: '#5d7fb8',
    high: '#c3d8f5',
    accent: '#ffffff',
    glow: '#8fb6ff',
  },
  [SURFACE_PROFILE.HOT_JUPITER]: {
    low: '#2d0708',
    mid: '#a12a1c',
    high: '#ffae4d',
    accent: '#fff0c2',
    glow: '#ff7a45',
  },
  [SURFACE_PROFILE.ICE]: {
    low: '#0a1c33',
    mid: '#4f7fa8',
    high: '#d7f0ff',
    accent: '#ffffff',
    glow: '#a8dcff',
  },
  [SURFACE_PROFILE.LAVA]: {
    low: '#150404',
    mid: '#7a1608',
    high: '#ff7a18',
    accent: '#ffe08a',
    glow: '#ff5a2b',
  },
  [SURFACE_PROFILE.HYCEAN]: {
    low: '#04212a',
    mid: '#12766f',
    high: '#7ef0dd',
    accent: '#dffdf6',
    glow: '#49e3cb',
  },
  [SURFACE_PROFILE.TIDAL_ROCK]: {
    low: '#101828',
    mid: '#8a5a3c',
    high: '#ffd9a8',
    accent: '#dff0ff',
    glow: '#ffab6b',
  },
}

/** Pick the surface profile from measured bulk properties. */
export function deriveSurfaceProfile(planet, classification) {
  const r = planet.radiusEarth
  const t = planet.equilibriumTemperatureK
  const giant = (r !== null && r >= 5.5) || (r === null && planet.massEarth !== null && planet.massEarth >= 20)

  if (giant) {
    if (t !== null && t >= 1000) return SURFACE_PROFILE.HOT_JUPITER
    return SURFACE_PROFILE.GAS_GIANT
  }
  if (classification.primary === 'Hycean Candidate') return SURFACE_PROFILE.HYCEAN
  if (r !== null && r >= 2.5) {
    if (t !== null && t >= 700) return SURFACE_PROFILE.HOT_JUPITER
    if (t !== null && t <= 180) return SURFACE_PROFILE.ICE
    return SURFACE_PROFILE.HYCEAN
  }
  // Rocky regime.
  if (t !== null && t >= 1000) return SURFACE_PROFILE.LAVA
  if (t !== null && t <= 175) return SURFACE_PROFILE.ICE
  if (classification.tags.includes('Ocean World Candidate')) return SURFACE_PROFILE.OCEAN
  if (classification.tags.includes('Tidally Locked Candidate')) return SURFACE_PROFILE.TIDAL_ROCK
  return SURFACE_PROFILE.ROCKY
}

/**
 * Build the shader palette. Purely an artistic model: no exoplanet in this
 * catalog has been imaged at a resolution that reveals surface appearance.
 */
export function derivePalette(planet, classification) {
  const profile = deriveSurfaceProfile(planet, classification)
  const base = { ...BASE_PALETTES[profile] }

  const species = planet.atmosphere?.species ?? []
  if (species.length) {
    for (const tint of SPECIES_TINTS) {
      if (species.some((s) => tint.match.test(s))) {
        base.glow = tint.glow
        base.accent = tint.accent
        break
      }
    }
  }

  const t = planet.equilibriumTemperatureK
  return {
    profile,
    ...base,
    // Shader modifiers, all in 0..1.
    bandStrength: profile === SURFACE_PROFILE.GAS_GIANT || profile === SURFACE_PROFILE.HOT_JUPITER ? 1 : 0.12,
    cloudStrength: species.length ? 0.85 : profile === SURFACE_PROFILE.ROCKY ? 0.25 : 0.5,
    tidalLock: classification.tags.includes('Tidally Locked Candidate') ? 1 : 0,
    heat: t === null ? 0.35 : Math.min(1, Math.max(0, (t - 150) / 2200)),
    atmosphereDensity:
      planet.atmosphere?.status === 'NO_THICK_ATMOSPHERE'
        ? 0.18
        : planet.atmosphere?.status === 'DETECTED'
          ? 1.0
          : planet.atmosphere?.status === 'TENTATIVE'
            ? 0.72
            : 0.5,
  }
}

/* ------------------------------------------------------------------ */
/* normalization                                                       */
/* ------------------------------------------------------------------ */

const EMPTY_ATMOSPHERE = { status: 'NOT_AVAILABLE', species: [], note: null }

/** Attach every derived layer to a base normalized record. */
function decorate(base) {
  const classification = classifyPlanet(base)
  const habitability = deriveHabitability(base)
  const palette = derivePalette(base, classification)

  return {
    ...base,
    classification: classification.primary,
    classificationTags: classification.tags,
    densityGCm3: deriveDensity(base.radiusEarth, base.massEarth),
    insolationEarth: deriveInsolation(
      base.hostStarRadiusSolar,
      base.hostStarTemperatureK,
      base.semiMajorAxisAu,
    ),
    tidallyLockedCandidate: deriveTidalLockCandidate(base),
    habitability,
    potentiallyHabitable: habitability.level >= 3,
    biosignatureStatus: deriveBiosignatureStatus(),
    palette,
    seed: hashString(base.id),
  }
}

/**
 * Normalize one row from the NASA Exoplanet Archive `pscomppars` table.
 * Returns null for rows without a planet name, which are unusable.
 */
export function normalizeArchiveRow(row) {
  const name = toText(row.pl_name)
  if (!name) return null

  const distancePc = toNumber(row.sy_dist)

  const base = {
    id: slugify(name),
    name,
    hostStarName: toText(row.hostname) ?? UNKNOWN,
    hostStarType: toText(row.st_spectype),
    hostStarTemperatureK: toNumber(row.st_teff),
    hostStarRadiusSolar: toNumber(row.st_rad),
    hostStarMassSolar: toNumber(row.st_mass),
    stellarMagnitude: toNumber(row.sy_vmag),
    planetsInSystem: toNumber(row.sy_pnum),
    starsInSystem: toNumber(row.sy_snum),
    distanceLy: distancePc === null ? null : distancePc * PC_TO_LY,
    radiusEarth: toNumber(row.pl_rade),
    massEarth: toNumber(row.pl_bmasse),
    massIsMinimum: toText(row.discoverymethod) === 'Radial Velocity',
    orbitalPeriodDays: toNumber(row.pl_orbper),
    semiMajorAxisAu: toNumber(row.pl_orbsmax),
    eccentricity: toNumber(row.pl_orbeccen),
    equilibriumTemperatureK: toNumber(row.pl_eqt),
    discoveryYear: toNumber(row.disc_year),
    discoveryMethod: toText(row.discoverymethod) ?? UNKNOWN,
    atmosphere: EMPTY_ATMOSPHERE,
    highlights: [],
    source: 'NASA Exoplanet Archive',
    sourceUrl: `https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(name)}`,
    isLive: true,
  }

  return decorate(base)
}

/** Normalize one entry from the bundled offline snapshot. */
export function normalizeRegistryEntry(entry) {
  const name = toText(entry.name)
  if (!name) return null

  const base = {
    id: toText(entry.id) ?? slugify(name),
    name,
    hostStarName: toText(entry.hostStarName) ?? UNKNOWN,
    hostStarType: toText(entry.hostStarType),
    hostStarTemperatureK: toNumber(entry.hostStarTemperatureK),
    hostStarRadiusSolar: toNumber(entry.hostStarRadiusSolar),
    hostStarMassSolar: toNumber(entry.hostStarMassSolar),
    stellarMagnitude: toNumber(entry.stellarMagnitude),
    planetsInSystem: toNumber(entry.planetsInSystem),
    starsInSystem: toNumber(entry.starsInSystem),
    distanceLy: toNumber(entry.distanceLy),
    radiusEarth: toNumber(entry.radiusEarth),
    massEarth: toNumber(entry.massEarth),
    massIsMinimum: Boolean(entry.massIsMinimum),
    orbitalPeriodDays: toNumber(entry.orbitalPeriodDays),
    semiMajorAxisAu: toNumber(entry.semiMajorAxisAu),
    eccentricity: toNumber(entry.eccentricity),
    equilibriumTemperatureK: toNumber(entry.equilibriumTemperatureK),
    discoveryYear: toNumber(entry.discoveryYear),
    discoveryMethod: toText(entry.discoveryMethod) ?? UNKNOWN,
    atmosphere: entry.atmosphere
      ? {
          status: toText(entry.atmosphere.status) ?? 'NOT_AVAILABLE',
          species: Array.isArray(entry.atmosphere.species) ? entry.atmosphere.species : [],
          note: toText(entry.atmosphere.note),
        }
      : EMPTY_ATMOSPHERE,
    highlights: Array.isArray(entry.highlights) ? entry.highlights : [],
    source: 'Local Catalog Snapshot',
    sourceUrl: toText(entry.sourceUrl) ?? 'https://exoplanetarchive.ipac.caltech.edu/',
    isLive: false,
  }

  return decorate(base)
}

/**
 * Merge curated annotations into live archive rows.
 *
 * The archive's composite-parameters table carries orbital and bulk properties
 * but no atmospheric composition. Where a live row matches a curated snapshot
 * entry by name, the curated atmosphere and highlight text is attached and
 * explicitly marked as coming from the literature snapshot rather than from the
 * live query. Measured numbers are never overwritten by snapshot values.
 */
export function annotateWithSnapshot(livePlanets, snapshotPlanets) {
  const byId = new Map(snapshotPlanets.map((p) => [p.id, p]))
  const byName = new Map(snapshotPlanets.map((p) => [p.name.toLowerCase().replace(/\s+/g, ''), p]))

  return livePlanets.map((planet) => {
    const match =
      byId.get(planet.id) ?? byName.get(planet.name.toLowerCase().replace(/\s+/g, '')) ?? null
    if (!match) return planet

    const merged = {
      ...planet,
      atmosphere: match.atmosphere,
      atmosphereProvenance: 'LITERATURE SNAPSHOT',
      highlights: match.highlights,
    }
    // Re-derive the palette: atmospheric species drive the artistic colours.
    const classification = { primary: merged.classification, tags: merged.classificationTags }
    merged.palette = derivePalette(merged, classification)
    return merged
  })
}

/**
 * Per-field provenance for the DATA TRUST block of the HUD.
 * Keeps the distinction between what was measured and what ASTROVITA computed
 * visible at all times.
 */
export function buildProvenance(planet) {
  const measuredOrUnavailable = (v) => (v === null ? PROVENANCE.UNAVAILABLE : PROVENANCE.MEASURED)
  return [
    { field: 'DISTANCE', tag: measuredOrUnavailable(planet.distanceLy) },
    { field: 'RADIUS', tag: measuredOrUnavailable(planet.radiusEarth) },
    {
      field: 'MASS',
      tag:
        planet.massEarth === null
          ? PROVENANCE.UNAVAILABLE
          : planet.massIsMinimum
            ? PROVENANCE.ESTIMATED
            : PROVENANCE.MEASURED,
    },
    {
      field: 'EQ. TEMPERATURE',
      tag: planet.equilibriumTemperatureK === null ? PROVENANCE.UNAVAILABLE : PROVENANCE.DERIVED,
    },
    { field: 'ORBITAL PERIOD', tag: measuredOrUnavailable(planet.orbitalPeriodDays) },
    {
      field: 'DENSITY',
      tag: planet.densityGCm3 === null ? PROVENANCE.UNAVAILABLE : PROVENANCE.DERIVED,
    },
    { field: 'CLASSIFICATION', tag: PROVENANCE.DERIVED },
    { field: 'HABITABILITY', tag: PROVENANCE.DERIVED },
    { field: 'SURFACE', tag: PROVENANCE.ARTISTIC },
    { field: 'ATMOSPHERE COLOUR', tag: PROVENANCE.ARTISTIC },
    { field: 'ORBIT SCALE', tag: PROVENANCE.ARTISTIC },
  ]
}

/** Human-readable atmosphere summary that never overstates the evidence. */
export function describeAtmosphere(planet) {
  const atmosphere = planet.atmosphere ?? EMPTY_ATMOSPHERE
  switch (atmosphere.status) {
    case 'DETECTED':
      return {
        headline: 'DETECTED',
        tone: 'positive',
        species: atmosphere.species,
        note: atmosphere.note,
      }
    case 'TENTATIVE':
      return {
        headline: 'TENTATIVE — UNCONFIRMED',
        tone: 'caution',
        species: atmosphere.species,
        note: atmosphere.note,
      }
    case 'NO_THICK_ATMOSPHERE':
      return {
        headline: 'NO THICK ATMOSPHERE DETECTED',
        tone: 'neutral',
        species: [],
        note: atmosphere.note,
      }
    default:
      return { headline: NOT_AVAILABLE, tone: 'neutral', species: [], note: atmosphere.note }
  }
}
