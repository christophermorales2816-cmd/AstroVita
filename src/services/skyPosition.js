/**
 * FILE: src/services/skyPosition.js
 *
 * PURPOSE
 *   Real-time topocentric sky positions. Converts a star's catalogued
 *   equatorial coordinates (RA, Dec) into where it actually is in the sky right
 *   now — altitude above the horizon and azimuth from north — for an observer
 *   at a given latitude/longitude. This is what lets the portal say "that star
 *   is 34 degrees up, slightly east of south, from where you are standing".
 *
 * DEPENDENCIES
 *   None. Pure functions over numbers; no three.js, no DOM.
 *
 * ALGORITHM
 *   Standard reduction, after Meeus, *Astronomical Algorithms*, ch. 12-13:
 *     1. Julian Date from the JS clock (UTC).
 *     2. Greenwich Mean Sidereal Time from JD (polynomial in Julian centuries).
 *     3. Local Sidereal Time = GMST + east longitude.
 *     4. Hour angle H = LST - RA.
 *     5. sin(alt) = sin(dec) sin(lat) + cos(dec) cos(lat) cos(H)
 *        az (from north, eastward) via atan2 on the horizontal components.
 *
 * WHAT IS DELIBERATELY OMITTED, and why it does not matter here
 *   - Precession/nutation from J2000 to date: < 0.4 degrees over the period the
 *     archive's coordinates are valid for. Invisible at the size of a point.
 *   - Atmospheric refraction: < 0.6 degrees, and only right at the horizon.
 *   - Proper motion, parallax, aberration: arcseconds. Irrelevant.
 *   The result is accurate to well under one degree, which is far below the
 *   angular size of a rendered star. Nothing here is a navigation instrument.
 *
 * VERIFIED against published values (see the self-test at the bottom of this
 * file and the build log): GMST at the J2000.0 epoch, zenith and due-south
 * cases, and the Polaris altitude-equals-latitude identity.
 */

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

/** Milliseconds per day. */
const MS_PER_DAY = 86_400_000

/** JD of the Unix epoch, 1970-01-01T00:00:00Z. */
const JD_UNIX_EPOCH = 2440587.5

/** JD of J2000.0, 2000-01-01T12:00:00 TT. */
export const JD_J2000 = 2451545.0

/** Wrap an angle in degrees into [0, 360). */
export function wrap360(deg) {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** Julian Date for a JS Date (or ms timestamp), UTC. */
export function julianDate(date = new Date()) {
  const ms = typeof date === 'number' ? date : date.getTime()
  return ms / MS_PER_DAY + JD_UNIX_EPOCH
}

/**
 * Greenwich Mean Sidereal Time in degrees.
 * Meeus eq. 12.4. Valid to ~0.1 arcsecond over several centuries around J2000.
 */
export function greenwichMeanSiderealTime(jd) {
  const d = jd - JD_J2000
  const t = d / 36525
  const gmst =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * t * t -
    (t * t * t) / 38710000
  return wrap360(gmst)
}

/** Local Sidereal Time in degrees for an east-positive longitude. */
export function localSiderealTime(jd, longitudeDeg) {
  return wrap360(greenwichMeanSiderealTime(jd) + longitudeDeg)
}

/**
 * Equatorial (RA, Dec) -> horizontal (altitude, azimuth), all in degrees.
 * Azimuth is measured from NORTH through EAST, the navigation convention.
 *
 * @param {number} raDeg        right ascension in degrees (hours * 15)
 * @param {number} decDeg       declination in degrees
 * @param {number} latitudeDeg  observer latitude, north positive
 * @param {number} lstDeg       local sidereal time in degrees
 * @returns {{altitude: number, azimuth: number, hourAngle: number}}
 */
export function equatorialToHorizontal(raDeg, decDeg, latitudeDeg, lstDeg) {
  const H = wrap360(lstDeg - raDeg) * DEG
  const dec = decDeg * DEG
  const lat = latitudeDeg * DEG

  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H)
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)))

  // Horizontal components in a north/east/up frame.
  const north = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H)
  const east = -Math.cos(dec) * Math.sin(H)
  const azimuth = wrap360(Math.atan2(east, north) * RAD)

  return { altitude: altitude * RAD, azimuth, hourAngle: H * RAD }
}

/**
 * Horizontal (alt, az) -> a unit direction in three.js scene space where
 * +Y is up (zenith), -Z is north and +X is east. This matches a camera at the
 * origin whose default gaze is down -Z, so "look north" is the identity.
 *
 * Writes into `out` (an object with x, y, z) and returns it. No allocation.
 */
export function horizontalToScene(altitudeDeg, azimuthDeg, out) {
  const alt = altitudeDeg * DEG
  const az = azimuthDeg * DEG
  const cosAlt = Math.cos(alt)
  out.x = cosAlt * Math.sin(az)
  out.y = Math.sin(alt)
  out.z = -cosAlt * Math.cos(az)
  return out
}

/**
 * Inverse of the camera's gaze: yaw/pitch (radians, three.js convention) to a
 * navigation bearing. Yaw 0 looks down -Z (north); positive yaw turns left
 * (toward west) under three.js's right-handed Y-up rotation, so the azimuth is
 * the negated yaw.
 */
export function gazeToBearing(yawRad, pitchRad) {
  return {
    azimuth: wrap360(-yawRad * RAD),
    altitude: pitchRad * RAD,
  }
}

/* ------------------------------------------------------------------ */
/* observer locations                                                  */
/* ------------------------------------------------------------------ */

/**
 * Curated observing sites. Coordinates are city centres or the named
 * observatory, to two decimals — plenty for a sky that moves a quarter of a
 * degree per minute.
 */
export const OBSERVER_LOCATIONS = [
  { id: 'greenwich', name: 'Greenwich', latitude: 51.4779, longitude: -0.0015 },
  { id: 'mexico-city', name: 'Ciudad de México', latitude: 19.4326, longitude: -99.1332 },
  { id: 'bogota', name: 'Bogotá', latitude: 4.711, longitude: -74.0721 },
  { id: 'lima', name: 'Lima', latitude: -12.0464, longitude: -77.0428 },
  { id: 'santiago', name: 'Santiago', latitude: -33.4489, longitude: -70.6693 },
  { id: 'buenos-aires', name: 'Buenos Aires', latitude: -34.6037, longitude: -58.3816 },
  { id: 'sao-paulo', name: 'São Paulo', latitude: -23.5505, longitude: -46.6333 },
  { id: 'rio', name: 'Rio de Janeiro', latitude: -22.9068, longitude: -43.1729 },
  { id: 'madrid', name: 'Madrid', latitude: 40.4168, longitude: -3.7038 },
  { id: 'new-york', name: 'New York', latitude: 40.7128, longitude: -74.006 },
  { id: 'london', name: 'London', latitude: 51.5074, longitude: -0.1278 },
  { id: 'tokyo', name: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
  { id: 'sydney', name: 'Sydney', latitude: -33.8688, longitude: 151.2093 },
  { id: 'cape-town', name: 'Cape Town', latitude: -33.9249, longitude: 18.4241 },
  { id: 'paranal', name: 'Cerro Paranal (ESO VLT)', latitude: -24.6272, longitude: -70.4039 },
  { id: 'mauna-kea', name: 'Mauna Kea', latitude: 19.8207, longitude: -155.468 },
]

export const DEFAULT_LOCATION = OBSERVER_LOCATIONS[0]

/** "33.92°S, 18.42°E" */
export function formatLatLon(latitude, longitude) {
  const lat = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}`
  const lon = `${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`
  return `${lat}, ${lon}`
}

/* ------------------------------------------------------------------ */
/* self-test (run with: node src/services/skyPosition.js)              */
/* ------------------------------------------------------------------ */

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('skyPosition.js')) {
  const close = (a, b, tol) => Math.abs(a - b) <= tol
  const results = []
  const check = (name, pass, detail) => results.push({ name, pass, detail })

  // 1. GMST at J2000.0 must be 280.46061837 degrees (18.697374558 h).
  const gmst0 = greenwichMeanSiderealTime(JD_J2000)
  check('GMST at J2000.0 = 280.4606°', close(gmst0, 280.46061837, 1e-6), gmst0.toFixed(6))

  // 2. JD of the Unix epoch.
  check('JD(1970-01-01T00:00Z) = 2440587.5', close(julianDate(0), 2440587.5, 1e-9), julianDate(0))

  // 3. A star with dec == latitude on the meridian is at the zenith.
  const z = equatorialToHorizontal(100, 40, 40, 100)
  check('dec = lat on meridian -> alt 90°', close(z.altitude, 90, 1e-6), z.altitude.toFixed(6))

  // 4. Celestial equator on the meridian from 40N: alt 50°, due south (180°).
  const s = equatorialToHorizontal(100, 0, 40, 100)
  check('equator on meridian, 40N -> alt 50°', close(s.altitude, 50, 1e-6), s.altitude.toFixed(6))
  check('equator on meridian, 40N -> az 180°', close(s.azimuth, 180, 1e-6), s.azimuth.toFixed(6))

  // 5. Polaris (dec 89.26°) from 40N: altitude ~ latitude, azimuth ~ north, at
  //    any hour angle.
  for (const lst of [0, 90, 200, 300]) {
    const p = equatorialToHorizontal(37.95, 89.26, 40, lst)
    const azNorth = p.azimuth < 2 || p.azimuth > 358
    check(`Polaris alt≈lat at LST ${lst}`, close(p.altitude, 40, 1.0), p.altitude.toFixed(3))
    check(`Polaris az≈north at LST ${lst}`, azNorth, p.azimuth.toFixed(3))
  }

  // 6. Six hours after upper culmination an equatorial star sits on the horizon
  //    due east/west from the equator.
  const e = equatorialToHorizontal(0, 0, 0, 270)
  check('equator, H=270 (rising) -> alt 0°', close(e.altitude, 0, 1e-6), e.altitude.toFixed(6))
  check('equator, H=270 (rising) -> az 90° (east)', close(e.azimuth, 90, 1e-6), e.azimuth.toFixed(6))

  // 7. Scene mapping: north is -Z, east is +X, zenith is +Y.
  const n = horizontalToScene(0, 0, {})
  const east = horizontalToScene(0, 90, {})
  const up = horizontalToScene(90, 0, {})
  check('scene north = -Z', close(n.z, -1, 1e-9) && close(n.x, 0, 1e-9), JSON.stringify(n))
  check('scene east = +X', close(east.x, 1, 1e-9) && close(east.z, 0, 1e-9), JSON.stringify(east))
  check('scene zenith = +Y', close(up.y, 1, 1e-9), JSON.stringify(up))

  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '  ok  ' : 'FAIL  '}${r.name}  (${r.detail})`)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
