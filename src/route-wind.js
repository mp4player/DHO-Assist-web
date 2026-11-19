import {wrappedDeltaX} from './vision.js';

export function windSpeedMultiplier(heading, windFrom) {
  const downwind = (windFrom + 180) % 360;
  const difference = Math.abs(((heading - downwind + 540) % 360) - 180);
  if (difference < 10) return .8;
  if (difference < 80) return 1;
  if (difference < 120) return .8;
  if (difference < 160) return .6;
  if (difference < 170) return .5;
  return .3;
}

export function sailingSpeedMultiplier(heading, {areaMultiplier, windFrom}) {
  return areaMultiplier * (Number.isFinite(windFrom) ? windSpeedMultiplier(heading, windFrom) : 1);
}

export function createWindModel(data, width) {
  // Move each upper layer before the lower one, preserving the other DB entries.
  const ordered = data.seas.filter(sea => sea.bounds);
  for (const {above, below} of data.overlapPrecedence) {
    const upper = ordered.findIndex(sea => sea.name === above);
    const lower = ordered.findIndex(sea => sea.name === below);
    if (lower >= 0 && upper > lower) ordered.splice(lower, 0, ...ordered.splice(upper, 1));
  }
  const wrap = x => ((x % width) + width) % width;
  const indexed = ordered.map(sea => {
    const [west, north, east, south] = sea.bounds;
    const span = east > west ? east - west : east + width - west;
    const bonus = Number.isFinite(sea.maxSpeedIncreasePercent) ? sea.maxSpeedIncreasePercent : 0;
    return {west: wrap(west), east: wrap(east), span, north, south, wind: sea.windFromDeg, areaMultiplier: 1 + bonus / 100};
  });
  const xEdges = [...new Set(indexed.flatMap(sea => [sea.west, sea.east]))];
  const yEdges = [...new Set(indexed.flatMap(sea => [sea.north, sea.south]))];

  function speedAt(x, y, season) {
    const sea = indexed.find(sea => y >= sea.north && y < sea.south && wrap(x - sea.west) < sea.span);
    return {areaMultiplier: sea?.areaMultiplier ?? 1, windFrom: sea?.wind?.[season]};
  }

  function seaMask(height, scale) {
    const columns = width / scale;
    const rows = height / scale;
    const cover = new Uint8Array(columns * rows);
    for (const {west, span, north, south} of indexed) {
      const firstRow = Math.max(0, Math.ceil(north / scale));
      const lastRow = Math.min(rows, Math.floor(south / scale));
      const firstColumn = Math.ceil(west / scale);
      const east = west + span;
      const lastColumn = Math.min(columns, Math.floor(east / scale));
      const wrappedColumns = Math.max(0, Math.floor((east - width) / scale));
      // A cell is eligible only when its full area lies inside the registered rectangle.
      for (let y = firstRow; y < lastRow; y++) {
        const row = y * columns;
        if (firstColumn < lastColumn) cover.fill(1, row + firstColumn, row + lastColumn);
        if (wrappedColumns) cover.fill(1, row, row + wrappedColumns);
      }
    }
    return cover;
  }

  function segment(a, b, heading, season) {
    let equivalentDistance = 0, unknownDistance = 0;
    const dx = wrappedDeltaX(a, b, width), dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const cuts = [0, 1];
    function cut(edge, start, delta) {
      const fraction = (edge - start) / delta;
      if (fraction > 0 && fraction < 1) cuts.push(fraction);
    }
    if (dx) for (const edge of xEdges) {
      cut(edge - width, a.x, dx);
      cut(edge, a.x, dx);
      cut(edge + width, a.x, dx);
    }
    if (dy) for (const edge of yEdges) cut(edge, a.y, dy);
    cuts.sort((a, b) => a - b);
    for (let j = 1; j < cuts.length; j++) {
      const portion = length * (cuts[j] - cuts[j - 1]);
      if (!portion) continue;
      const t = (cuts[j] + cuts[j - 1]) / 2;
      const x = a.x + t * dx, y = a.y + t * dy;
      const speed = speedAt(x, y, season);
      if (!Number.isFinite(speed.windFrom)) unknownDistance += portion;
      equivalentDistance += portion / sailingSpeedMultiplier(heading, speed);
    }
    return {distance: length, equivalentDistance, unknownDistance};
  }

  function sail(legs, season) {
    const result = {distance: 0, equivalentDistance: 0, unknownDistance: 0};
    for (const leg of legs) {
      for (const [i, heading] of (leg.headings ?? []).entries()) {
        const cost = segment(leg.points[i], leg.points[i + 1], heading, season);
        result.distance += cost.distance;
        result.equivalentDistance += cost.equivalentDistance;
        result.unknownDistance += cost.unknownDistance;
      }
    }
    return result;
  }
  return {sail, segment, speedAt, seaMask};
}
