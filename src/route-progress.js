import {wrappedDeltaX} from './vision.js';

const waypointRadius = 8;
const routeCorridor = 16;

export function createRouteProgress(legs, width) {
  const steps = [];
  let total = 0;
  for (const [legIndex, leg] of legs.entries()) {
    if (leg.mode !== '해상') {
      const next = legs[legIndex + 1];
      if (!next || next.mode === '해상') {
        steps.push({legIndex, end: next?.points[0] ?? leg.points.at(-1), sailed: total});
      }
      continue;
    }
    for (let i = 0; i < (leg.headings?.length ?? 0); i++) {
      const start = leg.points[i], end = leg.points[i + 1];
      const dx = wrappedDeltaX(start, end, width), dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) steps.push({legIndex, i, start, end, dx, dy, length, sailed: total});
      total += length;
    }
  }

  let cursor = 0;
  let previous = null;
  function delta(a, b) { return [wrappedDeltaX(a, b, width), b.y - a.y]; }
  function distance(a, b) { return Math.hypot(...delta(a, b)); }

  function projection(step, fix) {
    const [dx, dy] = delta(step.start, fix);
    return {
      along: (dx * step.dx + dy * step.dy) / step.length,
      across: Math.abs(dx * step.dy - dy * step.dx) / step.length,
    };
  }

  function passed(step, fix, prior) {
    const radius = step.length ? Math.max(1.5, Math.min(waypointRadius, step.length / 3)) : waypointRadius;
    if (distance(step.end, fix) <= radius) return true;
    if (!step.length || !prior || distance(prior, fix) > 4 * routeCorridor) return false;
    const before = projection(step, prior), after = projection(step, fix);
    if (before.along < 0 || before.along >= step.length || after.along < step.length) return false;
    if (before.across > routeCorridor || after.across > routeCorridor) return false;
    const [dx, dy] = delta(prior, fix), [ex, ey] = delta(prior, step.end);
    return Math.abs(dx * ey - dy * ex) / Math.hypot(dx, dy) <= radius;
  }

  return {
    observe(fix) {
      const before = cursor;
      if (fix) {
        // Check the observed motion against the current waypoint, then accept
        // coincident waypoints only if the new fix also reaches them.
        if (steps[cursor] && passed(steps[cursor], fix, previous)) cursor++;
        while (steps[cursor] && passed(steps[cursor], fix, null)) cursor++;
      }
      previous = fix;
      return cursor !== before;
    },
    get completed() { return steps.length > 0 && cursor === steps.length; },
    get advanced() { return cursor > 0; },
    remainingDistance(fix) {
      const step = steps[cursor];
      if (!fix || !step?.length) return null;
      const {along, across} = projection(step, fix);
      if (across > routeCorridor || along < -routeCorridor || along > step.length + routeCorridor) return null;
      return total - step.sailed - Math.max(0, Math.min(along, step.length));
    },
    remainingLegs() {
      if (!cursor) return legs;
      const done = steps[cursor - 1];
      if (done.i === undefined || done.i + 1 === legs[done.legIndex].headings.length) return legs.slice(done.legIndex + 1);
      const leg = legs[done.legIndex];
      const index = done.i + 1;
      return [{...leg, points: leg.points.slice(index), headings: leg.headings.slice(index)}, ...legs.slice(done.legIndex + 1)];
    },
  };
}
