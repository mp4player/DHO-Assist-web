import assert from 'node:assert/strict';
import test from 'node:test';
import {windSeasonAt} from '../src/route-season.js';

test('the reference summer phase starts at the exact nine-hour boundary', () => {
  const origin = Date.parse('2005-03-16T13:30:00+09:00');
  const period = 9 * 60 * 60 * 1000;
  assert.deepEqual(windSeasonAt(origin - 1), {season: 'winter', nextChange: origin});
  assert.deepEqual(windSeasonAt(origin), {season: 'summer', nextChange: origin + period});
  assert.deepEqual(windSeasonAt(origin + period - 1), {season: 'summer', nextChange: origin + period});
  assert.deepEqual(windSeasonAt(origin + period), {season: 'winter', nextChange: origin + 2 * period});
  assert.equal(windSeasonAt(origin + 2 * period).season, 'summer');
});

test('Korean dates and UTC use the same season even across midnight', () => {
  assert.deepEqual(windSeasonAt(Date.parse('2026-11-17T00:00:00+09:00')), {
    season: 'winter', nextChange: Date.parse('2026-11-16T16:30:00Z'),
  });
  assert.equal(windSeasonAt(Date.parse('2026-11-17T01:30:00Z')).season, 'winter');
});
