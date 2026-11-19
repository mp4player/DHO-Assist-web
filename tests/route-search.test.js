import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createPortLookup, findSeaRoute, markOcean} from '../src/route-search.js';
import {createTransfers} from '../src/route-transfers.js';
import {windSpeedMultiplier} from '../src/route-wind.js';
import {wrappedDeltaX} from '../src/vision.js';

test('inland cities resolve ports through direct and intermediate connections', () => {
  const {cities} = JSON.parse(readFileSync(new URL('../../DB/cities.json', import.meta.url), 'utf8'));
  const lookup = [...createPortLookup(cities).values()];
  const paths = name => lookup.find(city => city.name === name).ports.map(port => port.names.join(' → ')).sort();
  assert.deepEqual(paths('오마하'), ['오마하 → 보스턴', '오마하 → 새크라멘토 → 샌프란시스코']);
  assert.deepEqual(paths('피렌체'), ['피렌체 → 베네치아', '피렌체 → 피사']);
});

test('sea search chooses the closest port across the wrapped map', () => {
  const width = 10, height = 4;
  const water = markOcean(new Uint8Array(width * height).fill(1), width, height, 0);
  const port = (x, name) => ({point: {x, y: 1}, names: [name]});
  const route = findSeaRoute(water, width, height, 1, [port(9, 'departure')], [port(6, 'far'), port(0, 'near')]);
  assert.deepEqual(route.arrival.names, ['near']);
  assert.equal(route.distance, 1);
  assert.deepEqual(route.legs[0].points, [{x: 9.5, y: 1.5}, {x: .5, y: 1.5}]);
  assert.deepEqual(route.legs[0].headings, [90]);
});

test('sea search excludes isolated water and avoids cutting land corners', () => {
  const rows = ['.......', '..#....', '.#.#...', '..#....', '.......'];
  const width = rows[0].length, height = rows.length;
  const water = markOcean(Uint8Array.from(rows.join(''), cell => Number(cell === '.')), width, height, 0);
  assert.equal(water[2 * width + 2], 1);
  const port = (x, y) => ({point: {x, y}, names: []});
  const route = findSeaRoute(water, width, height, 1, [port(1.5, 1.5)], [port(3.5, 3.5)]);
  assert.ok(route.distance > 3);
  const snapped = findSeaRoute(water, width, height, 1, [port(2.5, 2.5)], [port(.5, .5)]);
  assert.notDeepEqual(snapped.legs[0].points[0], {x: 2.5, y: 2.5});
});

test('automatic transfers include only enabled modes and keep the optional exits one-way', () => {
  const {cities} = JSON.parse(readFileSync(new URL('../../DB/cities.json', import.meta.url), 'utf8'));
  const {landings} = JSON.parse(readFileSync(new URL('../../DB/landings.json', import.meta.url), 'utf8'));
  const places = new Map([...cities, ...landings].map(place => [place.name, place]));
  const flags = {rail: true, tacoma: true, southeast: true, east: true, canalCart: true, camel: true};
  assert.deepEqual(createTransfers(places, flags), {stops: [], edges: []});
  const {edges} = createTransfers(places, {...flags, automatic: true});
  const base = createTransfers(places, {automatic: true, rail: true, canalCart: true});
  assert.equal(base.edges.length, 18);
  assert.equal(edges.length, 26);
  const allowed = (from, to, mode) => edges.some(edge => edge.from === from && edge.to === to && edge.mode === mode);
  for (const exit of ['타코마', '북미 대륙 남동쪽 연안', '북미 대륙 동쪽 연안']) {
    for (const station of ['새크라멘토', '오마하']) {
      assert.ok(allowed(station, exit, '철도'));
      assert.ok(!allowed(exit, station, '철도'));
    }
  }
  assert.ok(allowed('샌프란시스코', '새크라멘토', '철도'));
  assert.ok(allowed('오마하', '새크라멘토', '철도'));
  assert.ok(allowed('마르세이유', '파리', '마차'));
  assert.ok(allowed('포르토벨로', '파나마', '운하'));
  assert.ok(allowed('바스라', '수에즈', '낙타'));
  assert.deepEqual(createTransfers(places, {automatic: true, tacoma: true, camel: true}), {stops: [], edges: []});
});

test('search uses a directed transfer across land only in the allowed direction', () => {
  const rows = ['....#.......', '....#.......', '....#.......', '....#.......', '............'];
  const width = rows[0].length, height = rows.length;
  const water = markOcean(Uint8Array.from(rows.join(''), cell => Number(cell === '.')), width, height, 0);
  const west = {point: {x: 2.5, y: 1.5}, names: ['west']};
  const east = {point: {x: 6.5, y: 1.5}, names: ['east']};
  const transfers = {
    stops: [
      {name: 'station', point: {x: 3.5, y: 1.5}, coastal: true},
      {name: 'exit', point: {x: 5.5, y: 1.5}, coastal: true},
    ],
    edges: [{from: 'station', to: 'exit', mode: '철도'}],
  };
  const forward = findSeaRoute(water, width, height, 1, [west], [east], transfers);
  assert.deepEqual(forward.legs.map(leg => [leg.mode, ...leg.names]),
    [['해상', 'west', 'station'], ['철도', 'station', 'exit'], ['해상', 'exit', 'east']]);
  const reverse = findSeaRoute(water, width, height, 1, [east], [west], transfers);
  assert.deepEqual(reverse.legs.map(leg => leg.mode), ['해상']);
  assert.ok(reverse.distance > forward.distance);
});

function coastalFixture() {
  const width = 48, height = 20;
  const water = new Uint8Array(width * height).fill(1);
  for (const [x, y, w, h] of [[8, 9, 2, 3], [16, 11, 2, 2], [17, 3, 1, 2], [5, 7, 1, 1]]) {
    for (let row = y; row < y + h; row++) water.fill(0, row * width + x, row * width + x + w);
  }
  markOcean(water, width, height, 0);
  const start = [{point: {x: 2, y: 30}, names: ['start']}];
  const end = [{point: {x: 80, y: 50}, names: ['end']}];
  return {water, width, height, start, end};
}

test('fewest turns can choose a longer route with fewer real heading changes', () => {
  const {water, width, height, start, end} = coastalFixture();
  const distance = findSeaRoute(water, width, height, 4, start, end);
  const turns = findSeaRoute(water, width, height, 4, start, end, undefined, 'turns');
  assert.ok(distance.distance < turns.distance);
  assert.ok(distance.legs[0].turns > turns.legs[0].turns);
  assert.equal(turns.legs[0].turns, 1);
  assert.ok(turns.legs[0].headings.every(heading => heading % 2 === 0));
});

function timedRoutes(windFrom) {
  const {water, width, height, start, end} = coastalFixture();
  const factors = Array.from({length: 180}, (_, index) => 1 / windSpeedMultiplier(2 * index, windFrom));
  const segment = (a, b, heading) => Math.hypot(wrappedDeltaX(a, b, width * 4), b.y - a.y) * factors[heading / 2];
  const model = {factors: () => factors, segment};
  const [shortest, fewest, balanced] = ['distance', 'turns', 'balanced'].map(mode =>
    findSeaRoute(water, width, height, 4, start, end, undefined, mode, model));
  function time({legs: [{headings, points}]}) {
    return headings.reduce((sum, heading, i) => sum + segment(points[i], points[i + 1], heading), 0);
  }
  return {shortest, fewest, balanced, time};
}

test('balanced picks fewer turns among routes that beat the fewest-turn ETA', () => {
  const {shortest, fewest, balanced, time} = timedRoutes(30);
  assert.ok(balanced.legs[0].turns < shortest.legs[0].turns);
  assert.ok(time(balanced) < time(fewest));
  assert.ok(time(shortest) < time(balanced));
  assert.equal(balanced.legs[0].unsafeTurns, 0);
});

test('balanced retains the fewest-turn route when there is no shorter ETA among the candidates', () => {
  const {fewest, balanced} = timedRoutes(60);
  assert.deepEqual(balanced.legs, fewest.legs);
});
