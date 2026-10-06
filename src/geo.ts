export const EARTH_RADIUS_M = 6371008.8;

const TO_RAD = Math.PI / 180;

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * TO_RAD;
  const phi2 = lat2 * TO_RAD;
  const dPhi = (lat2 - lat1) * TO_RAD;
  let dLambda = (lon2 - lon1) * TO_RAD;
  if (dLambda > Math.PI) {
    dLambda -= 2 * Math.PI;
  } else if (dLambda < -Math.PI) {
    dLambda += 2 * Math.PI;
  }
  const sinHalfPhi = Math.sin(dPhi / 2);
  const sinHalfLambda = Math.sin(dLambda / 2);
  const a =
    sinHalfPhi * sinHalfPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
