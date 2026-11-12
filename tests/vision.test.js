import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCoordinates,compassAngle,directionVector,readSurveyText,measureMotion} from '../src/vision.js';
test('coordinate parsing rejects incomplete, out-of-world and extra numbers',()=>{assert.deepEqual(parseCoordinates('12345, 3456\n'),{x:12345,y:3456});for(const s of ['-1,100','12345','16384,100','50,8192','1 2 3','no coordinates'])assert.equal(parseCoordinates(s),null);});
test('compass rejects blank and detects a north red tip with offset',()=>{const im={width:100,height:100,data:new Uint8ClampedArray(40000)};assert.equal(compassAngle(im),null);for(let y=12;y<40;y++)for(let x=47;x<=52;x++){const i=(y*100+x)*4;im.data[i]=240;im.data[i+1]=20;im.data[i+2]=20;im.data[i+3]=255;}assert.ok(Math.abs(compassAngle(im).angle)<1);assert.ok(Math.abs(compassAngle(im,90).angle-90)<1);});
test('north and east direction vectors use map Y downward',()=>{assert.deepEqual(directionVector(0,100),{x:0,y:-100});assert.ok(Math.abs(directionVector(90,100).x-100)<.001);});

test('motion uses the shortest east/west displacement and has no course at rest', () => {
  const west = {x: 98, y: 20};
  const east = {x: 2, y: 20};
  assert.deepEqual(measureMotion(west, east, 2, 100), {speed: 2, course: 90});
  assert.deepEqual(measureMotion(east, west, 2, 100), {speed: 2, course: 270});
  assert.deepEqual(measureMotion(east, {x: 2, y: 26}, 3, 100), {speed: 2, course: 180});
  assert.deepEqual(measureMotion(east, east, 2, 100), {speed: 0, course: null});
  assert.equal(measureMotion(east, west, 0, 100), null);
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
