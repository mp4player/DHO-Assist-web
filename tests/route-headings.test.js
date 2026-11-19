import assert from 'node:assert/strict';
import test from 'node:test';
import {planSeaHeadings, turnHasClearance} from '../src/route-headings.js';
import {wrappedDeltaX} from '../src/vision.js';

function verifyGeometry(route, width, water) {
  assert.equal(route.headings.length, route.points.length - 1);
  for (const [i, heading] of route.headings.entries()) {
    assert.ok(heading >= 0 && heading < 360 && heading % 2 === 0);
    const from = route.points[i], to = route.points[i + 1];
    const dx = wrappedDeltaX(from, to, width), dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    const actual = Math.atan2(dx, -dy) * 180 / Math.PI;
    assert.ok(Math.abs(((actual - heading + 540) % 360) - 180) < 1e-8);
    for (let tick = 0; tick <= Math.ceil(length * 100); tick++) {
      const ratio = tick / Math.ceil(length * 100);
      const x = (Math.floor(from.x + dx * ratio) + width) % width;
      const y = Math.floor(from.y + dy * ratio);
      assert.equal(water[y * width + x], 2);
    }
  }
}

test('a 45-degree grid track gets two real headings rather than a rounded label', () => {
  const width = 24, height = 24;
  const water = new Uint8Array(width * height).fill(2);
  const route = planSeaHeadings([10 * width + 1, 9 * width + 2, 8 * width + 3, 7 * width + 4], water, width, height, 1);
  assert.deepEqual(route.headings, [44, 46]);
  assert.deepEqual(route.points[0], {x: 1.5, y: 10.5});
  assert.deepEqual(route.points.at(-1), {x: 4.5, y: 7.5});
  verifyGeometry(route, width, water);
});

test('coastal runs divide at safe cells when a single pair of headings would cross land', () => {
  const width = 256, height = 130;
  const water = Uint8Array.from({length: width * height}, (_, cell) => {
    return Math.abs(cell % width - Math.floor(cell / width)) <= 1 ? 2 : 0;
  });
  const cells = Array.from({length: 121}, (_, i) => (i + 2) * (width + 1));
  const route = planSeaHeadings(cells, water, width, height, 1);
  assert.ok(route.headings.length >= 4);
  assert.ok(route.unsafeTurns > 0, 'an unavoidable narrow channel still has a navigable route');
  assert.deepEqual(route.points.at(-1), {x: 122.5, y: 122.5});
  verifyGeometry(route, width, water);
});

test('the turn margin uses the actual land edge across the wrapped seam', () => {
  const width = 24, height = 24;
  const water = new Uint8Array(width * height).fill(2);
  water[10 * width] = 0;
  assert.equal(turnHasClearance({x: 21.5, y: 10.5}, water, width, height, 4), true);
  assert.equal(turnHasClearance({x: 21.51, y: 10.5}, water, width, height, 4), false);
  assert.equal(turnHasClearance({x: 22, y: 12.6}, water, width, height, 4), true);
});

test('true bearings and coast checks account for the horizontal world seam', () => {
  const width = 24, height = 12;
  const water = new Uint8Array(width * height).fill(2);
  const route = planSeaHeadings([6 * width + 22, 5 * width + 23, 4 * width, 3 * width + 1], water, width, height, 1);
  assert.deepEqual(route.headings, [44, 46]);
  assert.deepEqual(route.points.at(-1), {x: 1.5, y: 3.5});
  verifyGeometry(route, width, water);
});
