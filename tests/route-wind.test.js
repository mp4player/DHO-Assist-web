import assert from 'node:assert/strict';
import test from 'node:test';
import {createWindModel, sailingSpeedMultiplier, windSpeedMultiplier} from '../src/route-wind.js';

test('wind multipliers use the corrected bands on both sides of the downwind heading', () => {
  const bands = [[0, .8], [9, .8], [10, 1], [79, 1], [80, .8], [119, .8],
    [120, .6], [159, .6], [160, .5], [169, .5], [170, .3], [180, .3]];
  for (const [angle, multiplier] of bands) {
    for (const sign of [-1, 1]) {
      const heading = (180 + 270 + sign * angle) % 360;
      assert.equal(windSpeedMultiplier(heading, 270), multiplier);
    }
  }
});

test('time changes at wrapped sea boundaries and uses the upper overlapping region', () => {
  const data = {
    seas: [
      {name: 'wide', bounds: [80, 0, 120, 20], maxSpeedIncreasePercent: 100, windFromDeg: {summer: 90, winter: 270}},
      {name: 'narrow', bounds: [95, 0, 105, 20], maxSpeedIncreasePercent: 50, windFromDeg: {summer: 270, winter: 300}},
    ],
    overlapPrecedence: [{above: 'narrow', below: 'wide'}],
  };
  const {sail, speedAt} = createWindModel(data, 100);
  assert.ok(Math.abs(sailingSpeedMultiplier(90, speedAt(98, 10, 'summer')) - 1.2) < 1e-9);
  const legs = [{points: [{x: 90, y: 10}, {x: 10, y: 10}], headings: [90]}];
  const summer = sail(legs, 'summer');
  assert.equal(summer.distance, 20);
  assert.equal(summer.unknownDistance, 0);
  assert.ok(Math.abs(summer.equivalentDistance - (10 / (.3 * 2) + 10 / (.8 * 1.5))) < 1e-8);
  assert.ok(Math.abs(sail(legs, 'winter').equivalentDistance - (10 / (.8 * 2) + 10 / 1.5)) < 1e-8);
  const outside = sail([{points: [{x: 30, y: 10}, {x: 50, y: 10}], headings: [90]}], 'summer');
  assert.deepEqual(outside, {distance: 20, equivalentDistance: 20, unknownDistance: 20});
});

test('registered water excludes the southern edge and keeps both sides of a wrapped sea', () => {
  const {seaMask} = createWindModel({seas: [
    {name: 'wrapped', bounds: [24, 4, 40, 12]},
    {name: 'central', bounds: [12, 8, 20, 16]},
  ], overlapPrecedence: []}, 32);
  assert.deepEqual(Array.from(seaMask(20, 4)), [
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 0, 0, 0, 0, 1, 1,
    1, 1, 0, 1, 1, 0, 1, 1,
    0, 0, 0, 1, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
});
