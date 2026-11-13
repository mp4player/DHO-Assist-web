export function parseCoordinates(text, width=16384, height=8192) {
  const nums=text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const [x,y]=nums.map(Number);
  return x>=0 && y>=0 && x<width && y<height ? {x,y} : null;
}

export function gameHudRegions(width, height, {right = 0, bottom = 0} = {}) {
  width -= right;
  height -= bottom;
  if (width < 148 || height < 276) return {};
  // The survey and compass are anchored to the client area's bottom-right corner.
  // Leave a few pixels around the tiny survey text for window borders and OCR.
  return {
    coord: {x: width - 74, y: height - 276, w: 64, h: 16, gameHud: true},
    compass: {x: width - 148, y: height - 108, w: 113, h: 107, gameHud: true},
  };
}

// Bright pixels of the 5×10 glyphs observed in the game's survey HUD, at a 6 px pitch.
const surveyGlyphs = Object.entries({
  '0': '.##.. #..#. #..#. #..#. #..#. #..#. #..#. #..#. .##.. .....',
  '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. .....',
  '2': '.##.. #..#. #..#. ...#. ..#.. .#... .#... #.... ####. .....',
  '3': '.##.. #..#. #..#. ...#. .##.. ...#. #..#. #..#. .##.. .....',
  '4': '...#. ..##. ..##. .#.#. .#.#. #..#. ##### ...#. ...#. .....',
  '5': '####. #.... #.... ###.. #..#. ...#. #..#. #..#. .##.. .....',
  '6': '.##.. #..#. #..#. #.... ###.. #..#. #..#. #..#. .##.. .....',
  '7': '####. ...#. ...#. ..#.. ..#.. ..#.. .#... .#... .#... .....',
  '8': '.##.. #..#. #..#. #..#. .##.. #..#. #..#. #..#. .##.. .....',
  '9': '.##.. #..#. #..#. #..#. .###. ...#. #..#. #..#. .##.. .....',
  ',': '..... ..... ..... ..... ..... ..... ..... ###.. ..#.. ##...',
}).map(([character, rows]) => [character, rows.replaceAll(' ', '')]);

function matchSurveyGlyph(image, left, top) {
  let sample = '';
  for (let y = top; y < top + 10; y++) {
    for (let x = left; x < left + 5; x++) {
      const pixel = (y * image.width + x) * 4;
      const {data} = image;
      sample += Math.min(data[pixel], data[pixel + 1], data[pixel + 2]) >= 195 ? '#' : '.';
    }
  }
  if (!sample.includes('#')) return ' ';

  let match = '?';
  let best = Infinity;
  let next = Infinity;
  for (const [character, glyph] of surveyGlyphs) {
    let differences = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] !== glyph[i]) differences++;
    }
    if (differences < best) {
      next = best;
      best = differences;
      match = character;
    } else {
      next = Math.min(next, differences);
    }
  }
  return best <= 2 && next - best >= 2 ? match : '?';
}

export function readSurveyText(image) {
  const readings = new Set();
  // A small shift can come from the edge of the captured window.
  for (let top = 0; top + 10 <= image.height; top++) {
    for (let left = 0; left < 6; left++) {
      let row = '';
      for (let x = left; x + 5 <= image.width; x += 6) {
        row += matchSurveyGlyph(image, x, top);
      }
      const text = row.trim();
      if (/^\d{1,5}, *\d{1,5}$/.test(text)) readings.add(text.replaceAll(' ', ''));
    }
  }
  return readings.size === 1 ? readings.values().next().value : null;
}

export function gameCompassAngle(image, offset = 0) {
  const {data, width, height} = image;
  const scaleX = width / 113;
  const scaleY = height / 107;
  let east = 0;
  let north = 0;
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x / scaleX - 56) / 54;
      const dy = (39 - y / scaleY) / 46;
      const radius = Math.hypot(dx, dy);
      if (radius < .58 || radius > 1.3) continue;

      const index = (y * width + x) * 4;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const yellow = Math.min(red, green) - blue;
      if (Math.min(red, green) < 145 || yellow < 50 || Math.abs(red - green) > 45) continue;

      const weight = yellow * yellow;
      east += dx / radius * weight;
      north += dy / radius * weight;
      total += weight;
      count++;
    }
  }
  if (count < 8 || Math.hypot(east, north) / total < .6) return null;
  // The compass rotates with the ship, so the north marker turns the opposite way.
  const heading = -Math.atan2(east, north) * 180 / Math.PI;
  return {angle: ((heading + offset) % 360 + 360) % 360};
}
// Red tip must dominate one side of a centered compass. Reject weak/ambiguous signals.
export function compassAngle(image, offset=0) {
  const {data,width,height}=image; const cx=(width-1)/2,cy=(height-1)/2;
  let dx=0,dy=0,total=0,count=0;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*width+x)*4, r=data[i],g=data[i+1],b=data[i+2];
    const radius=Math.hypot((x-cx)/(width/2),(y-cy)/(height/2));
    if(radius<.16 || radius>.9 || r<100 || r-g<45 || r-b<35) continue;
    const weight=r-Math.max(g,b); dx+=(x-cx)*weight;dy+=(y-cy)*weight;total+=weight;count++;
  }
  const strength=total ? Math.hypot(dx,dy)/total/(Math.min(width,height)/2) : 0;
  if(count<8 || strength<.18) return null;
  return {angle:(Math.atan2(dx,-dy)*180/Math.PI+offset+720)%360, strength};
}
export function directionVector(angle,length) {
  const r=angle*Math.PI/180;return {x:Math.sin(r)*length,y:-Math.cos(r)*length};
}

// The sailing-day counter uses a separate, centered font with an 8 px digit pitch.
const dayGlyphs = [
  0b111110000001011100, 0b100001111111000000, 0b110011001011110011,
  0b110011001001110111, 0b001000011111000001, 0b101011101001000110,
  0b111111001001100110, 0b100011101110100000, 0b110110001001110110,
  0b111011000001011110,
];

export function hasSailingDay({data, width}, left = 0, top = 0) {
  function bright(x, y) {
    const pixel = ((top + y) * width + left + x) * 4;
    return data[pixel] + data[pixel + 1] + data[pixel + 2] > 384;
  }
  let count = 3;
  if (!bright(10, 4) && !bright(10, 10)) count = 2;
  else if (!bright(2, 4) && !bright(2, 10)) count = 1;
  for (let digit = 0; digit < count; digit++) {
    let glyph = 0;
    const start = (3 - count) * 4 + digit * 8;
    for (let x = 0; x < 6; x += 2) {
      for (let y = 0; y < 11; y += 2) {
        glyph = (glyph << 1) | Number(bright(start + x, y));
      }
    }
    if (!dayGlyphs.includes(glyph)) return false;
  }
  return true;
}

export function findSailingDay(image) {
  for (let y = 0; y <= image.height - 11; y++) {
    for (let x = 0; x <= image.width - 21; x++) {
      if (hasSailingDay(image, x, y)) return {x, y};
    }
  }
  return null;
}

export function estimatePosition(fix, elapsed, worldWidth, worldHeight) {
  const displacement = directionVector(fix.angle, fix.speed * elapsed);
  const x = ((fix.position.x + displacement.x) % worldWidth + worldWidth) % worldWidth;
  const y = Math.max(0, Math.min(worldHeight - 1, fix.position.y + displacement.y));
  return {x, y};
}

export function shouldEstimatePosition(attempts, windowMs) {
  const latest = attempts.at(-1);
  if (!latest?.failed) return false;

  let total = 0;
  let failures = 0;
  let consecutive = true;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const {time, failed} = attempts[i];
    const age = latest.time - time;
    if (age > windowMs && !consecutive) break;
    consecutive &&= failed;
    if (consecutive && age >= 2000) return true;
    if (age <= windowMs) {
      total++;
      if (failed) failures++;
    }
  }
  // A single failed read can be half of a short window during startup.
  return failures >= 2 && failures * 2 >= total;
}

function wrappedDeltaX(previous, current, worldWidth) {
  const rawX = current.x - previous.x;
  return Math.abs(rawX) > worldWidth / 2 ? rawX - Math.sign(rawX) * worldWidth : rawX;
}

export function appendMotionSamples(samples, previous, current, worldWidth) {
  const intervalMs = 1000;
  let time = samples.at(-1).time + intervalMs;
  if (time > current.time) return false;

  const dx = wrappedDeltaX(previous.position, current.position, worldWidth);
  const dy = current.position.y - previous.position.y;
  for (; time <= current.time; time += intervalMs) {
    const fraction = (time - previous.time) / (current.time - previous.time);
    const x = previous.position.x + dx * fraction;
    const y = previous.position.y + dy * fraction;
    samples.push({time, position: {x: (x + worldWidth) % worldWidth, y}});
  }
  return true;
}

function courseFromDisplacement(dx, dy) {
  return dx || dy ? (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360 : null;
}

export function measureAverageMotion(fixes, windowMs, worldWidth) {
  if (fixes.length < 2) return null;
  const end = fixes.at(-1).time;
  const start = Math.max(fixes[0].time, end - windowMs);
  if (!(end > start && worldWidth > 0)) return null;

  let dx = 0;
  let dy = 0;
  let distance = 0;
  for (let i = fixes.length - 1; i > 0 && fixes[i].time > start; i--) {
    const previous = fixes[i - 1];
    const current = fixes[i];
    // Use only the fraction of this segment inside the averaging window.
    const fraction = (current.time - Math.max(previous.time, start)) / (current.time - previous.time);
    const segmentX = wrappedDeltaX(previous.position, current.position, worldWidth) * fraction;
    const segmentY = (current.position.y - previous.position.y) * fraction;
    dx += segmentX;
    dy += segmentY;
    distance += Math.hypot(segmentX, segmentY);
  }
  return {speed: distance * 1000 / (end - start), course: courseFromDisplacement(dx, dy)};
}
