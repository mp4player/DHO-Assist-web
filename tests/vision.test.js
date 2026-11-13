import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCoordinates,compassAngle,directionVector,gameHudRegions,readSurveyText,appendMotionSamples,measureAverageMotion,shouldEstimatePosition} from '../src/vision.js';
test('coordinate parsing rejects incomplete, out-of-world and extra numbers',()=>{assert.deepEqual(parseCoordinates('12345, 3456\n'),{x:12345,y:3456});for(const s of ['-1,100','12345','16384,100','50,8192','1 2 3','no coordinates'])assert.equal(parseCoordinates(s),null);});
test('compass rejects blank and detects a north red tip with offset',()=>{const im={width:100,height:100,data:new Uint8ClampedArray(40000)};assert.equal(compassAngle(im),null);for(let y=12;y<40;y++)for(let x=47;x<=52;x++){const i=(y*100+x)*4;im.data[i]=240;im.data[i+1]=20;im.data[i+2]=20;im.data[i+3]=255;}assert.ok(Math.abs(compassAngle(im).angle)<1);assert.ok(Math.abs(compassAngle(im,90).angle-90)<1);});
test('north and east direction vectors use map Y downward',()=>{assert.deepEqual(directionVector(0,100),{x:0,y:-100});assert.ok(Math.abs(directionVector(90,100).x-100)<.001);});

test('motion uses the shortest east/west displacement and has no course at rest', () => {
  const west = {x: 98, y: 20};
  const east = {x: 2, y: 20};
  const motion = (start, end, time) => measureAverageMotion([
    {position: start, time: 0}, {position: end, time},
  ], 1000, 100);
  assert.deepEqual(motion(west, east, 2000), {speed: 2, course: 90});
  assert.deepEqual(motion(east, west, 2000), {speed: 2, course: 270});
  assert.deepEqual(motion(east, {x: 2, y: 26}, 3000), {speed: 2, course: 180});
  assert.deepEqual(motion(east, east, 2000), {speed: 0, course: null});
  assert.equal(motion(east, west, 0), null);
});

test('game HUD regions can be anchored inside the captured window border', () => {
  const regions = gameHudRegions(810, 633, {right: 4, bottom: 5});
  assert.deepEqual(regions, {
    coord: {x: 732, y: 352, w: 64, h: 16, gameHud: true},
    compass: {x: 658, y: 520, w: 113, h: 107, gameHud: true},
  });
  assert.deepEqual(gameHudRegions(148, 276, {right: 4, bottom: 5}), {});
});

test('average motion weights segments by time, including partial segments and stops', () => {
  const fixes = [
    {position: {x: 98, y: 20}, time: 0},
    {position: {x: 0, y: 20}, time: 2000},
    {position: {x: 0, y: 19}, time: 2500},
    {position: {x: 0, y: 19}, time: 3000},
  ];
  const full = measureAverageMotion(fixes, 60_000, 100);
  assert.equal(full.speed, 1);
  assert.ok(Math.abs(full.course - 63.43495) < 0.00001);
  assert.deepEqual(measureAverageMotion(fixes, 2000, 100), {speed: 1, course: 45});
  assert.deepEqual(measureAverageMotion(fixes, 1000, 100), {speed: 1, course: 0});
  assert.deepEqual(measureAverageMotion(fixes.slice(-2), 1000, 100), {speed: 0, course: null});
  assert.equal(measureAverageMotion(fixes.slice(0, 1), 1000, 100), null);
  assert.deepEqual(measureAverageMotion([
    ...fixes, {position: {x: 0, y: 19}, time: 63_000},
  ], 60_000, 100), {speed: 0, course: null});
});

test('motion samples use a fixed time grid when recognition gets faster', () => {
  const start = {time: 0, position: {x: 99, y: 20}};
  const samples = [start];
  const corner = {time: 500, position: {x: 0, y: 20}};
  const end = {time: 1000, position: {x: 0, y: 19}};
  assert.equal(appendMotionSamples(samples, start, corner, 100), false);
  assert.equal(appendMotionSamples(samples, corner, end, 100), true);
  const slowSamples = [start];
  appendMotionSamples(slowSamples, start, end, 100);
  assert.deepEqual(samples, slowSamples);
  assert.deepEqual(measureAverageMotion(samples, 1000, 100), {speed: Math.SQRT2, course: 45});

  const afterGap = {time: 3500, position: {x: 5, y: 19}};
  appendMotionSamples(samples, end, afterGap, 100);
  assert.deepEqual(samples.slice(-2), [
    {time: 2000, position: {x: 2, y: 19}},
    {time: 3000, position: {x: 4, y: 19}},
  ]);
});

test('position estimates require repeated failures or a two-second run of failures', () => {
  const attempts = [
    {time: 0, failed: false},
    {time: 200, failed: false},
    {time: 400, failed: true},
    {time: 600, failed: true},
  ];
  assert.equal(shouldEstimatePosition(attempts.slice(0, 3), 200), false);
  assert.equal(shouldEstimatePosition(attempts, 1000), true);
  assert.equal(shouldEstimatePosition([...attempts, {time: 800, failed: false}], 1000), false);

  const mostlySuccessful = [
    ...Array.from({length: 10}, (_, i) => ({time: i * 100, failed: false})),
    {time: 1000, failed: true},
    {time: 2999, failed: true},
  ];
  assert.equal(shouldEstimatePosition(mostlySuccessful, 20_000), false);
  assert.equal(shouldEstimatePosition([...mostlySuccessful, {time: 3000, failed: true}], 20_000), true);
});

test('survey reader accepts shifted HUD pixels and rejects a digit ambiguous between 3 and 8', () => {
  const width = 64;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  const left = 13;
  const top = 4;
  const rows = [
    '..#.. .##.. ..... .##..',
    '.##.. #..#. ..... #..#.',
    '..#.. #..#. ..... #..#.',
    '..#.. #..#. ..... #..#.',
    '..#.. #..#. ..... .##..',
    '..#.. #..#. ..... #..#.',
    '..#.. #..#. ..... #..#.',
    '..#.. #..#. ###.. #..#.',
    '..#.. .##.. ..#.. .##..',
    '..... ..... ##... .....',
  ];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') {
        const pixel = ((top + y) * width + left + x) * 4;
        data.fill(255, pixel, pixel + 4);
      }
    }
  });
  assert.equal(readSurveyText({width, height, data}), '10,8');
  const ambiguousPixel = ((top + 3) * width + left + 18) * 4;
  data.fill(0, ambiguousPixel, ambiguousPixel + 4);
  assert.equal(readSurveyText({width, height, data}), null);
});
