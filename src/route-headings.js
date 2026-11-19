import {directionVector} from './vision.js';

const headingStep = 2;
const headingBins = 12;
const timeTolerance = 1e-6;
const modulo = (value, width) => ((value % width) + width) % width;
const headingVectors = Array.from({length: 360 / headingStep}, (_, i) => directionVector(i * headingStep, 1));

function gridTurns(cells, width) {
  const first = cells[0];
  const turns = [{x: first % width + .5, y: Math.floor(first / width) + .5}];
  let point = turns[0];
  let previousDx, previousDy;
  const maxRun = Math.max(1, Math.floor((width - 1) / 2));
  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i], previous = cells[i - 1];
    const raw = cell % width - previous % width;
    const dx = Math.abs(raw) > width / 2 ? raw - Math.sign(raw) * width : raw;
    const dy = Math.floor(cell / width) - Math.floor(previous / width);
    if (i > 1 && (dx !== previousDx || dy !== previousDy || Math.abs(point.x - turns.at(-1).x) >= maxRun)) {
      turns.push(point);
    }
    point = {x: point.x + dx, y: point.y + dy};
    previousDx = dx;
    previousDy = dy;
  }
  if (cells.length > 1) turns.push(point);
  return turns;
}

// Traverse every crossed mask cell, including both neighbors when a line crosses a corner.
function blockedAt(a, b, water, width, height) {
  const isWater = (x, y) => y >= 0 && y < height && water[y * width + modulo(x, width)] === 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const stepX = Math.sign(dx), stepY = Math.sign(dy);
  const strideX = 1 / Math.abs(dx), strideY = 1 / Math.abs(dy);
  let x = Math.floor(a.x), y = Math.floor(a.y);
  const endX = Math.floor(b.x), endY = Math.floor(b.y);
  let crossX = stepX ? (stepX > 0 ? x + 1 - a.x : a.x - x) * strideX : Infinity;
  let crossY = stepY ? (stepY > 0 ? y + 1 - a.y : a.y - y) * strideY : Infinity;
  const onVerticalBorder = !stepX && Number.isInteger(a.x);
  const onHorizontalBorder = !stepY && Number.isInteger(a.y);
  let reached = 0;
  while (isWater(x, y)
      && (!onVerticalBorder || isWater(x - 1, y))
      && (!onHorizontalBorder || isWater(x, y - 1))) {
    if (x === endX && y === endY) return Infinity;
    const nextX = x === endX ? Infinity : crossX;
    const nextY = y === endY ? Infinity : crossY;
    if (Math.abs(nextX - nextY) < 1e-10) {
      reached = nextX;
      if (!isWater(x + stepX, y) || !isWater(x, y + stepY)) return reached;
      x += stepX;
      y += stepY;
      crossX += strideX;
      crossY += strideY;
    } else if (nextX < nextY) {
      reached = nextX;
      x += stepX;
      crossX += strideX;
    } else {
      reached = nextY;
      y += stepY;
      crossY += strideY;
    }
  }
  return reached;
}

function clearLine(a, b, water, width, height) {
  return blockedAt(a, b, water, width, height) === Infinity;
}

export function turnHasClearance(point, water, width, height, scale) {
  const radius = 10 / scale;
  for (let y = Math.max(0, Math.floor(point.y - radius)); y <= Math.min(height - 1, Math.floor(point.y + radius)); y++) {
    const dy = Math.max(y - point.y, point.y - y - 1, 0);
    for (let x = Math.floor(point.x - radius); x <= Math.floor(point.x + radius); x++) {
      if (water[y * width + modulo(x, width)] !== 0) continue;
      const dx = Math.max(x - point.x, point.x - x - 1, 0);
      if (dx * dx + dy * dy < radius * radius - 1e-9) return false;
    }
  }
  return true;
}

function stepsTo(state) {
  const sections = [];
  for (; state.parent; state = state.parent) sections.push(state.steps);
  return sections.reverse().flat();
}

function optimize(candidates, options, better, unsafePoint, balance) {
  const states = candidates.map(() => new Map());
  const nearCoast = candidates.map(unsafePoint);
  states[0].set(null, {distance: 0, turns: 0, unsafe: 0, timeCost: 0, heading: null});
  function connect(from, to) {
    for (const steps of options(from, to)) {
      let length = 0, timeCost = 0, unsafe = 0;
      let previous = candidates[from];
      for (const [index, step] of steps.entries()) {
        length += Math.hypot(step.to.x - previous.x, step.to.y - previous.y);
        if (balance) timeCost += balance.segment(previous, step.to, step.heading);
        if (index > 0) unsafe += Number(unsafePoint(previous));
        previous = step.to;
      }
      const heading = steps.at(-1).heading;
      for (const parent of states[from].values()) {
        const turnAtStart = parent.heading !== null && parent.heading !== steps[0].heading;
        const turns = parent.turns + steps.length - 1 + Number(turnAtStart);
        if (balance && turns > balance.maxTurns) continue;
        const candidate = {distance: parent.distance + length, turns, heading, parent, steps,
          timeCost: parent.timeCost + timeCost, unsafe: parent.unsafe + unsafe + Number(turnAtStart && nearCoast[from])};
        const key = balance ? turns * 360 + heading : heading;
        if (better(candidate, states[to].get(key))) states[to].set(key, candidate);
      }
    }
  }
  for (let from = 0; from < candidates.length - 1; from++) {
    if (!states[from].size) continue;
    const last = Math.min(from + 16, candidates.length - 1);
    for (let to = from + 1; to <= last; to++) connect(from, to);
    if (last < candidates.length - 1) connect(from, candidates.length - 1);
  }
  let best;
  for (const candidate of states.at(-1).values()) if ((balance?.choose ?? better)(candidate, best)) best = candidate;
  return best;
}

function refineTurns(start, route, water, width, height, better, unsafePoint, balance) {
  const steps = stepsTo(route);
  const candidates = [start, ...steps.map(step => step.to)];
  const ranges = [];
  const windFactors = balance && candidates.map(point => balance.factors(point));
  function rays(index) {
    return ranges[index] ??= headingVectors.map(direction => {
      const point = candidates[index];
      const limit = Math.min(route.distance, (width / 2 - 1e-6) / Math.abs(direction.x));
      const end = {x: point.x + direction.x * limit, y: point.y + direction.y * limit};
      return limit * Math.min(1, blockedAt(point, end, water, width, height));
    });
  }
  function shortcuts(from, to) {
    const adjacent = to === from + 1;
    const options = adjacent ? [[steps[from]]] : [];
    const a = candidates[from], b = candidates[to];
    const dx = b.x - a.x, dy = b.y - a.y;
    const angle = modulo(Math.atan2(dx, -dy) * 180 / Math.PI, 360);
    const rounded = Math.round(angle / headingStep) * headingStep;
    if (!adjacent && Math.abs(dx) < width / 2 && Math.abs(angle - rounded) < 1e-9 && clearLine(a, b, water, width, height)) {
      options.push([{to: b, heading: rounded % 360}]);
    }

    const availableFrom = rays(from), availableTo = rays(to);
    const half = headingVectors.length / 2;
    // Keep a small set spanning incoming and outgoing headings. Exact sea-by-sea
    // travel times are evaluated by the optimizer after this rough ranking.
    const windOffset = headingBins * 2;
    const shortlist = new Array(balance ? windOffset * 2 : windOffset);
    for (let i = 0; i < headingVectors.length; i++) {
      if (availableFrom[i] < .25) continue;
      const u = headingVectors[i];
      for (let j = 0; j < headingVectors.length; j++) {
        const reverse = availableTo[(j + half) % headingVectors.length];
        if (reverse < .25) continue;
        const v = headingVectors[j];
        const determinant = u.x * v.y - u.y * v.x;
        if (Math.abs(determinant) < 1e-9) continue;
        const lengthA = (dx * v.y - dy * v.x) / determinant;
        const lengthB = (u.x * dy - u.y * dx) / determinant;
        if (lengthA < .25 || lengthB < .25 || lengthA > availableFrom[i] || lengthB > reverse) continue;
        const length = lengthA + lengthB;
        const firstBin = Math.floor(i * headingBins / headingVectors.length);
        const lastBin = headingBins + Math.floor(j * headingBins / headingVectors.length);
        const keepsShorter = bin => shortlist[bin]?.unsafe === 0 && length >= shortlist[bin].length - 1e-9;
        if (!balance && keepsShorter(firstBin) && keepsShorter(lastBin)) continue;
        const pivot = {x: a.x + u.x * lengthA, y: a.y + u.y * lengthA};
        const unsafe = Number(unsafePoint(pivot));
        const score = balance ? lengthA * windFactors[from][i] + lengthB * windFactors[to][j] : 0;
        const improves = (bin, rank) => {
          const old = shortlist[bin];
          return !old || unsafe < old.unsafe || (unsafe === old.unsafe && (rank < old.rank - 1e-9 ||
            (Math.abs(rank - old.rank) <= 1e-9 && length < old.length)));
        };
        const first = improves(firstBin, length), last = improves(lastBin, length);
        const firstWind = balance && improves(windOffset + firstBin, score);
        const lastWind = balance && improves(windOffset + lastBin, score);
        if (!first && !last && !firstWind && !lastWind) continue;
        if (!clearLine(a, pivot, water, width, height) || !clearLine(pivot, b, water, width, height)) continue;
        const steps = [{to: pivot, heading: i * headingStep}, {to: b, heading: j * headingStep}];
        const choice = {steps, unsafe, rank: length, length};
        if (first) shortlist[firstBin] = choice;
        if (last) shortlist[lastBin] = choice;
        if (firstWind || lastWind) {
          const windChoice = {steps, unsafe, rank: score, length};
          if (firstWind) shortlist[windOffset + firstBin] = windChoice;
          if (lastWind) shortlist[windOffset + lastBin] = windChoice;
        }
      }
    }
    options.push(...new Set(shortlist.filter(Boolean).map(choice => choice.steps)));
    return options;
  }
  return optimize(candidates, shortcuts, better, unsafePoint, balance);
}

export function planSeaHeadings(cells, water, width, height, scale, objective = 'distance', windModel, alternative = null) {
  const unsafePoint = point => !turnHasClearance(point, water, width, height, scale);
  function headingOptions(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    // Rendering uses the shorter wrapped displacement between consecutive points.
    if (Math.abs(dx) >= width / 2) return [];
    const angle = modulo(Math.atan2(dx, -dy) * 180 / Math.PI, 360);
    const nearest = Math.round(angle / headingStep) * headingStep;
    if (Math.abs(angle - nearest) < 1e-9) {
      return clearLine(from, to, water, width, height) ? [[{to, heading: nearest % 360}]] : [];
    }
    const lower = Math.floor(angle / headingStep) * headingStep;
    const upper = (lower + headingStep) % 360;
    const a = directionVector(lower, 1), b = directionVector(upper, 1);
    const determinant = a.x * b.y - a.y * b.x;
    const lengthA = (dx * b.y - dy * b.x) / determinant;
    const lengthB = (a.x * dy - a.y * dx) / determinant;
    // A quarter of a mask cell is one game coordinate on the world map.
    if (Math.min(lengthA, lengthB) < .25) return [];
    const options = [];
    for (const [first, second, direction, length] of [[lower, upper, a, lengthA], [upper, lower, b, lengthB]]) {
      const pivot = {x: from.x + direction.x * length, y: from.y + direction.y * length};
      if (clearLine(from, pivot, water, width, height) && clearLine(pivot, to, water, width, height)) {
        options.push([{to: pivot, heading: first}, {to, heading: second}]);
      }
    }
    return options;
  }

  function addSafeTurns(from, to, result) {
    if (headingOptions(from, to).length) { result.push(to); return; }
    // A single diagonal grid step has all four surrounding cells open.
    const length = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    if (length <= 1) throw new Error('Cannot turn through the sea grid at a 2-degree heading');
    const fraction = Math.floor(length / 2) / length;
    const midpoint = {x: from.x + Math.round((to.x - from.x) * fraction),
      y: from.y + Math.round((to.y - from.y) * fraction)};
    addSafeTurns(from, midpoint, result);
    addSafeTurns(midpoint, to, result);
  }

  function compare(candidate, current, byTurns) {
    if (!current || candidate.unsafe !== current.unsafe) return !current || candidate.unsafe < current.unsafe;
    const distanceDifference = candidate.distance - current.distance;
    const turnDifference = candidate.turns - current.turns;
    const distanceOrder = Math.abs(distanceDifference) > 1e-8 ? distanceDifference : 0;
    return (byTurns ? turnDifference || distanceOrder : distanceOrder || turnDifference) < 0;
  }
  const byDistance = (candidate, current) => compare(candidate, current, false);
  const byTurns = (candidate, current) => compare(candidate, current, true);
  function routeSeeds(path) {
    const turns = gridTurns(path, width);
    const candidates = [turns[0]];
    for (let i = 1; i < turns.length; i++) addSafeTurns(turns[i - 1], turns[i], candidates);
    const options = (from, to) => headingOptions(candidates[from], candidates[to]);
    const distanceSeed = optimize(candidates, options, byDistance, unsafePoint);
    const turnSeed = optimize(candidates, options, byTurns, unsafePoint);
    const distanceSteps = stepsTo(distanceSeed);
    const turnSteps = stepsTo(turnSeed);
    const same = distanceSteps.length === turnSteps.length && distanceSteps.every((step, i) =>
      step.heading === turnSteps[i].heading && step.to.x === turnSteps[i].to.x && step.to.y === turnSteps[i].to.y);
    return {start: turns[0], distanceSeed, turnSeed, seeds: same ? [distanceSeed] : [distanceSeed, turnSeed]};
  }
  const {start, distanceSeed, turnSeed, seeds} = routeSeeds(cells);
  const other = alternative && routeSeeds(alternative);
  const turnSeeds = other ? [...seeds, ...other.seeds] : seeds;
  const initialFewest = other && byTurns(other.turnSeed, turnSeed) ? other.turnSeed : turnSeed;
  function refineBest(best, better, candidates) {
    for (const seed of candidates) {
      if (seed.turns < 2) continue;
      const refined = refineTurns(start, seed, water, width, height, better, unsafePoint);
      if (better(refined, best)) best = refined;
    }
    return best;
  }
  const onMap = point => ({x: modulo(point.x, width) * scale, y: point.y * scale});
  let best;
  if (objective === 'balanced' && windModel) {
    const shortest = refineBest(distanceSeed, byDistance, seeds);
    const fewest = refineBest(initialFewest, byTurns, turnSeeds);
    const segment = (a, b, heading) => windModel.segment(onMap(a), onMap(b), heading) / scale;
    function withTime(state) {
      let timeCost = 0, point = start;
      for (const step of stepsTo(state)) {
        timeCost += segment(point, step.to, step.heading);
        point = step.to;
      }
      return {...state, timeCost};
    }
    const reference = withTime(fewest);
    function compareTime(a, b) {
      const difference = a.timeCost - b.timeCost;
      return Math.abs(difference) > timeTolerance ? difference : 0;
    }
    function choose(next, old) {
      if (next.unsafe > reference.unsafe || compareTime(next, reference) >= 0) return false;
      if (!old || old === reference) return true;
      return (next.unsafe - old.unsafe || next.turns - old.turns || compareTime(next, old) || next.distance - old.distance) < 0;
    }
    function better(next, old) {
      return !old || (next.unsafe - old.unsafe || compareTime(next, old) || next.distance - old.distance) < 0;
    }
    const shortestWithTime = withTime(shortest);
    best = choose(shortestWithTime, reference) ? shortestWithTime : reference;
    const balance = {segment, choose, maxTurns: Math.max(fewest.turns, shortest.turns),
      factors: point => windModel.factors(onMap(point))};
    for (const seed of new Set([fewest, shortest, ...turnSeeds])) {
      if (!seed.turns && !balance.maxTurns) continue;
      const candidate = refineTurns(start, seed, water, width, height, better, unsafePoint, balance);
      if (candidate && choose(candidate, best)) best = candidate;
    }
  } else {
    best = objective === 'turns' ? refineBest(initialFewest, byTurns, turnSeeds) : refineBest(distanceSeed, byDistance, seeds);
  }

  const points = [], headings = [];
  let previous = start;
  for (const {to, heading} of stepsTo(best)) {
    const last = points.at(-1);
    if (headings.at(-1) !== heading || Math.abs(to.x - last.x) >= width / 2) {
      points.push(previous);
      headings.push(heading);
    }
    previous = to;
  }
  points.push(previous);
  return {points: points.map(onMap), headings, distance: best.distance * scale, turns: best.turns, unsafeTurns: best.unsafe};
}
