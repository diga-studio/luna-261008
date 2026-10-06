const EARTH_RADIUS_MILES = 3958.7613;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in miles between two lat/lon points (degrees),
 * using a spherical earth of radius 3958.7613 miles. The result is NOT
 * rounded; callers compare against commute radii at full precision.
 */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const a =
    sinDPhi * sinDPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  return 2 * EARTH_RADIUS_MILES * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
