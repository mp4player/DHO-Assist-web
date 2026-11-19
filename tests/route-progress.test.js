import assert from 'node:assert/strict';
import test from 'node:test';
import {createRouteProgress} from '../src/route-progress.js';

const point = (x, y) => ({x, y});
const sea = (points, headings) => ({mode: '해상', points, headings});

test('live distance projects onto the current segment and stops following outside it', () => {
  const leg = sea([point(10, 10), point(110, 10), point(110, 110)], [90, 180]);
  const route = createRouteProgress([leg], 16384);
  assert.equal(route.remainingDistance(point(70, 15)), 140);
  assert.equal(route.remainingDistance(point(70, 50)), null);
  assert.equal(route.observe(point(110, 110)), false);
  assert.deepEqual(route.remainingLegs(), [leg]);
  assert.equal(route.observe(point(109, 10)), true);
  assert.equal(route.remainingDistance(point(111, 30)), 80);
  assert.deepEqual(route.remainingLegs(), [sea(leg.points.slice(1), [180])]);
  assert.equal(route.observe(null), false);
  assert.equal(route.observe(point(110, 110)), true);
  assert.equal(route.completed, true);
  assert.deepEqual(route.remainingLegs(), []);
});

test('continuous fixes can cross a wrapped waypoint between frames, including after an eastward map seam', () => {
  const start = point(16340, 100), waypoint = point(12, 100), finish = point(12, 200);
  const route = createRouteProgress([sea([start, waypoint, finish], [90, 180])], 16384);
  const before = point(16380, 102), after = point(24, 102);
  assert.equal(route.remainingDistance(before), 116);
  assert.equal(route.observe(before), false);
  assert.equal(route.observe(null), false);
  assert.equal(route.observe(after), false, 'an OCR gap must not connect two fixes to pass a waypoint');
  assert.equal(route.observe(before), false, 'moving backwards must not pass a waypoint');
  assert.equal(route.observe(after), true);
  assert.deepEqual(route.remainingLegs(), [sea([waypoint, finish], [180])]);
});

test('following an itinerary resumes at its next sea departure after grouped land transfers', () => {
  const a = point(0, 100), b = point(100, 100), c = point(200, 100), d = point(300, 100), e = point(400, 100);
  const last = sea([d, e], [90]);
  const route = createRouteProgress([sea([a, b], [90]), {mode: '철도', points: [b, c]}, {mode: '마차', points: [c, d]}, last], 16384);
  assert.equal(route.remainingDistance(a), 200);
  assert.equal(route.observe(b), true);
  assert.equal(route.remainingLegs().length, 3);
  assert.equal(route.remainingDistance(c), null);
  assert.equal(route.observe(c), false);
  assert.equal(route.observe(d), true);
  assert.deepEqual(route.remainingLegs(), [last]);
  assert.equal(route.remainingDistance(d), 100);
});
