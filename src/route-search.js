import {planSeaHeadings, turnHasClearance} from './route-headings.js';

export const routeWorld = {width: 16384, height: 8192};

export function createPortLookup(cities) {
  const places = new Map(cities.map(city => [city.id, city]));
  const links = new Map(cities.map(city => [city.id, new Set()]));
  for (const city of cities) {
    for (const link of city.connections) {
      if (link.kind !== 'entrance' || link.direction !== 'both' || !places.has(link.targetId)) continue;
      links.get(city.id).add(link.targetId);
      links.get(link.targetId).add(city.id);
    }
  }
  function entrances(city) {
    const paths = [[city]];
    const visited = new Set([city.id]);
    const ports = [];
    for (const path of paths) {
      const place = path.at(-1);
      if (place.navigationType === 'port' && place.coord) {
        ports.push({point: place.coord, names: path.map(item => item.name)});
      } else if (place.navigationType === 'inland_city') {
        for (const id of links.get(place.id)) {
          if (visited.has(id)) continue;
          visited.add(id);
          paths.push([...path, places.get(id)]);
        }
      }
    }
    return ports;
  }
  return new Map(cities.map(city => [city.id, {
    name: city.name,
    inland: city.navigationType === 'inland_city',
    ports: entrances(city),
  }]).filter(([, city]) => city.ports.length));
}

const wrap = (x, width) => (x + width) % width;
const straight = 1000;
const diagonal = 1414;
const directions = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

export function markOcean(water, width, height, seed) {
  if (!water[seed]) throw new Error('Ocean seed is outside water');
  const queue = new Int32Array(water.length);
  queue[0] = seed;
  water[seed] = 2;
  let count = 1;
  for (let head = 0; head < count; head++) {
    const node = queue[head];
    const x = node % width;
    const y = (node - x) / width;
    const left = x === 0 ? node + width - 1 : node - 1;
    const right = x === width - 1 ? node - width + 1 : node + 1;
    if (water[left] === 1) { water[left] = 2; queue[count++] = left; }
    if (water[right] === 1) { water[right] = 2; queue[count++] = right; }
    if (y > 0 && water[node - width] === 1) { water[node - width] = 2; queue[count++] = node - width; }
    if (y + 1 < height && water[node + width] === 1) { water[node + width] = 2; queue[count++] = node + width; }
  }
  return water;
}

function closestWater(point, water, width, height, scale) {
  const column = Math.floor(point.x / scale);
  const row = Math.floor(point.y / scale);
  let best = null;
  let distance = Infinity;
  function check(x, y) {
    if (y < 0 || y >= height) return;
    const node = y * width + wrap(x, width);
    if (water[node] !== 2) return;
    const d = ((x + .5) * scale - point.x) ** 2 + ((y + .5) * scale - point.y) ** 2;
    if (d >= distance) return;
    distance = d;
    best = node;
  }
  check(column, row);
  for (let radius = 1; distance > ((radius - .5) * scale) ** 2 &&
      radius <= Math.max(width / 2, height); radius++) {
    for (let offset = -radius; offset <= radius; offset++) {
      check(column + offset, row - radius);
      check(column + offset, row + radius);
    }
    for (let offset = 1 - radius; offset < radius; offset++) {
      check(column - radius, row + offset);
      check(column + radius, row + offset);
    }
  }
  return best;
}

class SearchQueue {
  nodes = [];
  priorities = [];

  push(node, priority) {
    const {nodes, priorities} = this;
    let index = nodes.length;
    for (; index > 0;) {
      const parent = (index - 1) >> 1;
      if (priorities[parent] <= priority) break;
      nodes[index] = nodes[parent];
      priorities[index] = priorities[parent];
      index = parent;
    }
    nodes[index] = node;
    priorities[index] = priority;
  }

  pop() {
    const {nodes, priorities} = this;
    const first = nodes[0];
    const node = nodes.pop();
    const priority = priorities.pop();
    const count = nodes.length;
    if (!count) return first;
    let index = 0;
    for (let child = 1; child < count; child = 2 * index + 1) {
      if (child + 1 < count && priorities[child + 1] < priorities[child]) child++;
      if (priorities[child] >= priority) break;
      nodes[index] = nodes[child];
      priorities[index] = priorities[child];
      index = child;
    }
    nodes[index] = node;
    priorities[index] = priority;
    return first;
  }
}

function gridDistance(x, y, goalX, goalY, width) {
  const xDistance = Math.abs(goalX - x);
  const dx = Math.min(xDistance, width - xDistance);
  const dy = Math.abs(goalY - y);
  return straight * Math.max(dx, dy) + (diagonal - straight) * Math.min(dx, dy);
}

function routeLegs(chain, stops, links, water, width, height, scale, departure, arrival, objective, windModel, search) {
  const legs = [];
  const stopName = node => stops.get(node)?.name;
  for (let first = 0; first < chain.length - 1;) {
    const node = chain[first];
    const next = chain[first + 1];
    let last = first + 1;
    if (!stops.has(node) && !stops.has(next)) {
      while (last + 1 < chain.length && !stops.has(chain[last + 1])) last++;
      const cells = chain.slice(first, last + 1);
      const alternative = objective === 'distance' ? null : capeHornAlternative(cells, water, width, height, scale, search);
      legs.push({
        mode: '해상',
        names: [stopName(chain[first - 1]) ?? departure.names.at(-1),
          stopName(chain[last + 1]) ?? arrival.names.at(-1)],
        ...planSeaHeadings(cells, water, width, height, scale, objective, windModel, alternative),
      });
    } else if (stops.has(node) && stops.has(next)) {
      const mode = links.get(node).get(next).mode;
      while (links.get(chain[last])?.get(chain[last + 1])?.mode === mode) last++;
      const places = chain.slice(first, last + 1).map(id => stops.get(id));
      legs.push({mode, names: places.map(place => place.name), points: places.map(place => place.mapPoint)});
    }
    first = last;
  }
  if (!legs.length) {
    const first = chain[0];
    const point = stops.get(first)?.mapPoint ?? {x: (first % width + .5) * scale, y: (Math.floor(first / width) + .5) * scale};
    legs.push({mode: '해상', names: [departure.names.at(-1), arrival.names.at(-1)],
      distance: 0, points: [point], headings: []});
  }
  return legs;
}

function capeHornAlternative(cells, water, width, height, scale, search) {
  if (width * scale !== routeWorld.width || height * scale !== routeWorld.height) return null;
  const arcticSouth = 1536 / scale;
  const arcticMeridian = 12288 / scale;
  const start = cells[0], finish = cells.at(-1);
  if (Math.floor(start / width) < arcticSouth || Math.floor(finish / width) < arcticSouth ||
      !cells.some(cell => cell % width === arcticMeridian && Math.floor(cell / width) < arcticSouth)) return null;
  // Cape Horn lies south of the tip of South America in registered water.
  const cape = (6976 / scale) * width + 13312 / scale;
  if (water[cape] !== 2) return null;
  const approach = search([start], new Set([cape]), false);
  if (!approach) return null;
  const departure = search([cape], new Set([finish]), false);
  return departure && approach.concat(departure.slice(1));
}

export function findSeaRoute(water, width, height, scale, departures, arrivals, transfers = {stops: [], edges: []},
  objective = 'distance', windModel, avoidCoast = false) {
  const size = water.length;
  const stops = new Map();
  const stopIds = new Map();
  const links = new Map();
  function addLink(from, to, cost, mode = null) {
    if (!links.has(from)) links.set(from, new Map());
    links.get(from).set(to, {cost, mode});
  }
  for (const stop of transfers.stops) {
    const cell = stop.coastal ? closestWater(stop.point, water, width, height, scale)
      : Math.floor(stop.point.y / scale) * width + Math.floor(stop.point.x / scale);
    if (cell === null) continue;
    const id = size + stops.size;
    const x = cell % width, y = Math.floor(cell / width);
    const mapPoint = stop.coastal ? {x: (x + .5) * scale, y: (y + .5) * scale} : stop.point;
    stops.set(id, {...stop, x, y, mapPoint});
    stopIds.set(stop.name, id);
    if (stop.coastal) {
      addLink(cell, id, 0);
      addLink(id, cell, 0);
    }
  }
  for (const edge of transfers.edges) {
    const from = stopIds.get(edge.from), to = stopIds.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const a = stops.get(from), b = stops.get(to);
    // The prototype measures grid distance on every segment so the existing heuristic remains valid across transfers.
    addLink(from, to, Math.max(straight, gridDistance(a.x, a.y, b.x, b.y, width)), edge.mode);
  }

  function locate(ports) {
    const nodes = new Map();
    for (const port of ports) {
      const node = port.stop ? stopIds.get(port.stop) : closestWater(port.point, water, width, height, scale);
      if (node != null && !nodes.has(node)) nodes.set(node, port);
    }
    return nodes;
  }
  const starts = locate(departures);
  const goals = locate(arrivals);
  if (!starts.size || !goals.size) return null;
  const parents = new Int32Array(size + stops.size);
  const costs = new Float64Array(parents.length);
  const closed = new Uint8Array(parents.length);
  const shore = avoidCoast && new Uint8Array(size);
  function coastCost(node, x, y) {
    if (!shore[node]) shore[node] = turnHasClearance({x: x + .5, y: y + .5}, water, width, height, scale) ? 1 : 2;
    return shore[node] === 2 ? 3 * straight : 0;
  }
  function search(origins, destinations, allowTransfers) {
    parents.fill(0);
    closed.fill(0);
    const targets = [...destinations.keys()].map(node => stops.get(node) ?? {x: node % width, y: Math.floor(node / width)});
    function estimate(x, y) {
      let best = Infinity;
      for (const target of targets) best = Math.min(best, gridDistance(x, y, target.x, target.y, width));
      return best;
    }
    const queue = new SearchQueue();
    for (const node of origins) {
      parents[node] = -1;
      costs[node] = 0;
      const stop = stops.get(node);
      queue.push(node, estimate(stop?.x ?? node % width, stop?.y ?? Math.floor(node / width)));
    }
    function relax(from, to, stepCost, x, y) {
      if (closed[to]) return;
      const cost = costs[from] + stepCost;
      if (parents[to] && costs[to] <= cost) return;
      costs[to] = cost;
      parents[to] = from + 1;
      const h = estimate(x, y);
      queue.push(to, cost + h + h / 2 ** 32);
    }
    while (queue.nodes.length) {
      const node = queue.pop();
      if (closed[node]) continue;
      if (destinations.has(node)) {
        const chain = [node];
        while (parents[chain.at(-1)] !== -1) chain.push(parents[chain.at(-1)] - 1);
        return chain.reverse();
      }
      closed[node] = 1;
      const transfersFromNode = allowTransfers && links.get(node);
      if (transfersFromNode) {
        for (const [next, edge] of transfersFromNode) {
          const stop = stops.get(next);
          relax(node, next, edge.cost, stop?.x ?? next % width, stop?.y ?? Math.floor(next / width));
        }
      }
      if (node >= size) continue;
      const x = node % width;
      const y = (node - x) / width;
      for (const [dx, dy] of directions) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nx = wrap(x + dx, width);
        const next = ny * width + nx;
        if (water[next] !== 2 || closed[next]) continue;
        if (dx && dy && (water[y * width + nx] !== 2 || water[ny * width + x] !== 2)) continue;
        relax(node, next, (dx && dy ? diagonal : straight) + (shore ? coastCost(next, nx, ny) : 0), nx, ny);
      }
    }
    return null;
  }
  const chain = search(starts.keys(), goals, true);
  if (!chain) return null;
  const departure = starts.get(chain[0]), arrival = goals.get(chain.at(-1));
  const legs = routeLegs(chain, stops, links, water, width, height, scale, departure, arrival, objective, windModel, search);
  const distance = legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0);
  const route = {legs, distance, departure, arrival};
  const unsafe = plan => plan.legs.reduce((sum, leg) => sum + (leg.unsafeTurns ?? 0), 0);
  if (!avoidCoast && unsafe(route)) {
    const alternative = findSeaRoute(water, width, height, scale, departures, arrivals, transfers, objective, windModel, true);
    if (alternative && unsafe(alternative) < unsafe(route)) return alternative;
  }
  return route;
}
