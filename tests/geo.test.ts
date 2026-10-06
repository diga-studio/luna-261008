import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineMiles } from '../src/index.js';

const EARTH_RADIUS_MILES = 3958.7613;
const ONE_DEG_LAT_MILES = (EARTH_RADIUS_MILES * Math.PI) / 180;

test('one degree of longitude at the equator', () => {
  const d = haversineMiles(0, 0, 0, 1);
  assert.ok(Math.abs(d - ONE_DEG_LAT_MILES) < 1e-9, `got ${d}`);
});

test('one degree of latitude', () => {
  const d = haversineMiles(10, 40, 11, 40);
  assert.ok(Math.abs(d - ONE_DEG_LAT_MILES) < 1e-9, `got ${d}`);
});

test('identical points are zero miles apart', () => {
  assert.equal(haversineMiles(47.6, -122.3, 47.6, -122.3), 0);
});

test('distance is symmetric', () => {
  const a = haversineMiles(40.7128, -74.006, 34.0522, -118.2437);
  const b = haversineMiles(34.0522, -118.2437, 40.7128, -74.006);
  assert.equal(a, b);
});

test('crossing the 180th meridian takes the short way', () => {
  // 0.2 degrees apart across the antimeridian, not 359.8 degrees.
  const d = haversineMiles(10, 179.9, 10, -179.9);
  const expected = 2 * EARTH_RADIUS_MILES * Math.asin(
    Math.cos((10 * Math.PI) / 180) * Math.sin((0.2 * Math.PI) / 360),
  );
  assert.ok(Math.abs(d - expected) < 1e-9, `got ${d}, want ~${expected}`);
  assert.ok(d < 15, `got ${d}`);
});

test('known reference distance (NYC to LA ~ 2445 mi)', () => {
  const d = haversineMiles(40.7128, -74.006, 34.0522, -118.2437);
  assert.ok(d > 2400 && d < 2500, `got ${d}`);
});
