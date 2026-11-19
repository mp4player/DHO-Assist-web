import {directionVector, wrappedDeltaX} from './vision.js';

const minZoom = 0.5;
const maxZoom = 32;
const zoomStep = 1.25;
const positionRadius = 6;
const routeColor = '#b9a4ff';
const plannedRouteColor = '#529dff';
const wrap = (value, period) => ((value % period) + period) % period;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createMapView(canvas, {zoomIn, zoomOut, reset, zoomLevel}) {
  const context = canvas.getContext('2d');
  const background = document.createElement('canvas');
  const backgroundContext = background.getContext('2d', {alpha: false});
  let backgroundInputs = [];
  let drawnRoutePoints = 0;
  const routeDays = [];
  let {width, height} = canvas;
  let aspect = 2;
  let zoom = 1;
  let left = 0;
  let top = 0;
  let drag = null;
  let dirty = true;
  let lastDraw = [];
  let plannedRoute = null;

  function moveTo(x, y) {
    const tileHeight = height * zoom;
    left = -wrap(-x, tileHeight * aspect);
    top = tileHeight < height ? (height - tileHeight) / 2 : clamp(y, height - tileHeight, 0);
    dirty = true;
  }

  function resize(nextWidth, nextHeight, nextAspect = aspect) {
    if (!nextWidth || !nextHeight) return;
    if (width === nextWidth && height === nextHeight && aspect === nextAspect) return;

    const centerX = (width / 2 - left) / (height * zoom * aspect);
    const centerY = (height / 2 - top) / (height * zoom);
    if (width !== nextWidth) canvas.width = width = nextWidth;
    if (height !== nextHeight) canvas.height = height = nextHeight;
    aspect = nextAspect;
    moveTo(width / 2 - centerX * height * zoom * aspect, height / 2 - centerY * height * zoom);
  }

  resize(canvas.clientWidth, canvas.clientHeight);
  const viewportObserver = new ResizeObserver(() => resize(canvas.clientWidth, canvas.clientHeight));
  viewportObserver.observe(canvas);

  function updateZoomControls() {
    zoomLevel.value = Math.round(zoom * 100);
    zoomIn.disabled = zoom >= maxZoom;
    zoomOut.disabled = zoom <= minZoom;
  }

  function zoomTo(nextZoom, x = width / 2, y = height / 2) {
    const next = clamp(nextZoom, minZoom, maxZoom);
    if (next === zoom) return;
    const ratio = next / zoom;
    zoom = next;
    moveTo(x - (x - left) * ratio, y - (y - top) * ratio);
    updateZoomControls();
  }

  function showPlannedRoute(legs, settings, fit = true) {
    plannedRoute = legs;
    dirty = true;
    if (!fit) return;
    const points = legs?.flatMap(leg => leg.points);
    if (!points?.length) return;
    const {worldWidth, worldHeight, originX, originY} = settings;
    let x = points[0].x;
    let minX = x, maxX = x, minY = points[0].y, maxY = minY;
    for (let i = 1; i < points.length; i++) {
      x += wrappedDeltaX(points[i - 1], points[i], worldWidth);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, points[i].y);
      maxY = Math.max(maxY, points[i].y);
    }
    const fitX = width * .86 * worldWidth / (Math.max(1, maxX - minX) * height * aspect);
    const fitY = .8 * worldHeight / Math.max(1, maxY - minY);
    zoom = clamp(Math.min(zoom, fitX, fitY), minZoom, maxZoom);
    const tileHeight = height * zoom;
    moveTo(width / 2 - ((minX + maxX) / 2 - originX) / worldWidth * tileHeight * aspect,
      height / 2 - ((minY + maxY) / 2 - originY) / worldHeight * tileHeight);
    updateZoomControls();
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - canvas.clientLeft) * width / canvas.clientWidth,
      y: (event.clientY - bounds.top - canvas.clientTop) * height / canvas.clientHeight,
    };
  }

  zoomIn.onclick = () => zoomTo(zoom * zoomStep);
  zoomOut.onclick = () => zoomTo(zoom / zoomStep);
  zoomLevel.onchange = () => {
    if (zoomLevel.value !== '' && Number.isFinite(zoomLevel.valueAsNumber)) zoomTo(zoomLevel.valueAsNumber / 100);
    updateZoomControls();
  };
  reset.onclick = () => {
    zoom = 1;
    moveTo((width - height * aspect) / 2, 0);
    updateZoomControls();
  };
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const delta = event.deltaX || event.deltaY;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientWidth : 1;
      moveTo(left - delta * unit * width / canvas.clientWidth, top);
      return;
    }
    if (event.deltaY === 0) return;
    const {x, y} = point(event);
    zoomTo(event.deltaY < 0 ? zoom * zoomStep : zoom / zoomStep, x, y);
  }, {passive: false});
  canvas.onpointerdown = event => {
    if (drag || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    drag = {id: event.pointerId, ...point(event)};
    canvas.classList.add('panning');
  };
  canvas.onpointermove = event => {
    if (drag?.id !== event.pointerId) return;
    const {x, y} = point(event);
    moveTo(left + x - drag.x, top + y - drag.y);
    drag.x = x;
    drag.y = y;
  };
  canvas.onlostpointercapture = event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    canvas.classList.remove('panning');
  };
  canvas.onkeydown = event => {
    switch (event.key) {
      case 'ArrowLeft': moveTo(left + 60, top); break;
      case 'ArrowRight': moveTo(left - 60, top); break;
      case 'ArrowUp': moveTo(left, top + 60); break;
      case 'ArrowDown': moveTo(left, top - 60); break;
      default: return;
    }
    event.preventDefault();
  };
  updateZoomControls();

  function drawGrid(context, x, tileWidth, tileHeight, worldWidth, originX) {
    context.strokeStyle = '#1d3a48';
    context.lineWidth = 1;
    context.fillStyle = '#5a7d90';
    context.font = '12px monospace';
    context.beginPath();
    for (let i = 0; i <= 8; i++) {
      const column = x + i * tileWidth / 8;
      const row = top + i * tileHeight / 8;
      context.moveTo(column, top);
      context.lineTo(column, top + tileHeight);
      context.moveTo(x, row);
      context.lineTo(x + tileWidth, row);
      if (i < 8) context.fillText(Math.round(originX + i * worldWidth / 8), column + 6, top + 18);
    }
    context.stroke();
    context.fillText('좌표 격자 · 지도 이미지를 불러오세요', x + 18, top + tileHeight - 20);
  }

  function drawDirection(x, y, tileWidth, dx, dy, color, dash, dayStep, firstDayFraction) {
    if (!dx && !dy) return;
    const first = Math.ceil((-x - Math.max(0, dx) - 2) / tileWidth);
    const last = Math.floor((width - x - Math.min(0, dx) + 2) / tileWidth);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash(dash);
    context.beginPath();
    for (let copy = first; copy <= last; copy++) {
      const start = x + copy * tileWidth;
      context.moveTo(start, y);
      context.lineTo(start + dx, y + dy);
    }
    context.stroke();
    context.setLineDash([]);

    if (!(dayStep > 0 && dayStep * firstDayFraction <= 1 + Number.EPSILON)) return;
    const length = Math.hypot(dx, dy);
    const unitX = dx / length;
    const unitY = dy / length;
    // Coalesce marks whose tips would fall within the same screen pixel.
    const stride = Math.max(1, Math.ceil(1 / (length * dayStep)));
    const firstDay = dayStep * firstDayFraction;
    context.lineWidth = 1.5;
    context.beginPath();
    for (let copy = first; copy <= last; copy++) {
      const start = x + copy * tileWidth;
      for (let t = firstDay; t <= 1 + Number.EPSILON; t += dayStep * stride) {
        const tipX = start + dx * t;
        const tipY = y + dy * t;
        if (tipX < -8 || tipX > width + 8 || tipY < -8 || tipY > height + 8) continue;
        const tailX = tipX - unitX * 6;
        const tailY = tipY - unitY * 6;
        context.moveTo(tailX - unitY * 3, tailY + unitX * 3);
        context.lineTo(tipX, tipY);
        context.lineTo(tailX + unitY * 3, tailY - unitX * 3);
      }
    }
    context.stroke();
  }

  function drawPosition(x, y, tileWidth, position, estimated) {
    context.font = '12px monospace';
    const label = estimated ? `예상 ${Math.floor(position.x)}, ${Math.floor(position.y)}` : `${position.x}, ${position.y}`;
    const labelWidth = context.measureText(label).width + 14;
    const first = Math.ceil((-x - labelWidth) / tileWidth);
    const last = Math.floor((width - x + 16) / tileWidth);
    for (let copy = first; copy <= last; copy++) {
      const marker = x + copy * tileWidth;
      context.fillStyle = estimated ? '#ffca80' : '#80efd0';
      context.beginPath();
      context.arc(marker, y, positionRadius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = estimated ? '#ffca8066' : '#80efd066';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(marker, y, 15, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#fff';
      context.fillText(label, marker + 14, y - 12);
    }
  }

  function traceRoute(points, firstPoint, context, tileWidth, worldWidth, xFor, yFor) {
    const scaleX = tileWidth / worldWidth;
    context.beginPath();
    for (let i = Math.max(1, firstPoint); i < points.length; i++) {
      const point = points[i];
      if (point.start) continue;
      const previous = points[i - 1];
      const y = yFor(previous);
      const nextY = yFor(point);
      if (Math.max(y, nextY) < 0 || Math.min(y, nextY) > height) continue;
      const x = xFor(previous);
      const dx = wrappedDeltaX(previous, point, worldWidth) * scaleX;
      const first = Math.ceil((-x - Math.max(0, dx) - 2) / tileWidth);
      const last = Math.floor((width - x - Math.min(0, dx) + 2) / tileWidth);
      for (let copy = first; copy <= last; copy++) {
        const start = x + copy * tileWidth;
        context.moveTo(start, y);
        context.lineTo(start + dx, nextY);
      }
    }
  }

  function drawPlannedRoute(tileWidth, worldWidth, xFor, yFor) {
    const transferColor = '#ffb857';
    for (const leg of plannedRoute) {
      const sea = leg.mode === '해상';
      context.lineWidth = 6;
      context.strokeStyle = '#102235';
      context.setLineDash(sea ? [] : [7, 5]);
      traceRoute(leg.points, 1, context, tileWidth, worldWidth, xFor, yFor);
      context.stroke();
      context.lineWidth = 3;
      context.strokeStyle = sea ? plannedRouteColor : transferColor;
      context.stroke();
    }
    context.setLineDash([]);
    context.font = 'bold 11px system-ui';
    context.textAlign = 'center';
    context.lineWidth = 3;
    context.strokeStyle = '#102235';
    context.fillStyle = '#e0edff';
    let lastLabel;
    for (const leg of plannedRoute) {
      if (!leg.headings) continue;
      for (const [i, heading] of leg.headings.entries()) {
        const point = leg.points[i];
        const x = xFor(point), y = yFor(point);
        if (y < 18 || y > height - 4) continue;
        const first = Math.ceil((16 - x) / tileWidth);
        const last = Math.floor((width - 16 - x) / tileWidth);
        for (let copy = first; copy <= last; copy++) {
          const center = x + copy * tileWidth;
          if (lastLabel && Math.abs(center - lastLabel.x) < 44 && Math.abs(y - lastLabel.y) < 18) continue;
          const label = `${heading}°`;
          context.beginPath();
          context.arc(center, y, 2.5, 0, Math.PI * 2);
          context.fill();
          context.strokeText(label, center, y - 8);
          context.fillText(label, center, y - 8);
          lastLabel = {x: center, y};
        }
      }
    }
    context.textAlign = 'start';
    const firstLeg = plannedRoute[0], lastLeg = plannedRoute.at(-1);
    const endpoints = [
      [firstLeg.points[0], firstLeg.mode],
      [lastLeg.points.at(-1), lastLeg.mode],
    ];
    for (const [point, mode] of endpoints) {
      const x = xFor(point);
      const y = yFor(point);
      const first = Math.ceil((-x - 6) / tileWidth);
      const last = Math.floor((width - x + 6) / tileWidth);
      context.fillStyle = mode === '해상' ? plannedRouteColor : transferColor;
      context.strokeStyle = '#102235';
      context.lineWidth = 2;
      for (let copy = first; copy <= last; copy++) {
        context.beginPath();
        context.arc(x + copy * tileWidth, y, 5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }
  }

  function drawRouteDays(points, dayInterval, tileWidth, xFor, yFor) {
    context.font = 'bold 8px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const point of points) {
      const labeled = dayInterval > 0 && point.day % dayInterval === 0;
      const radius = labeled ? positionRadius : 2;
      const y = yFor(point);
      if (y < -radius || y > height + radius) continue;
      const x = xFor(point);
      const first = Math.ceil((-x - radius) / tileWidth);
      const last = Math.floor((width - x + radius) / tileWidth);
      for (let copy = first; copy <= last; copy++) {
        const centerX = x + copy * tileWidth;
        context.fillStyle = routeColor;
        context.beginPath();
        context.arc(centerX, y, radius, 0, Math.PI * 2);
        context.fill();
        if (labeled) {
          context.fillStyle = '#101625';
          context.fillText(String(point.day), centerX, y, 10);
        }
      }
    }
    context.textAlign = 'start';
    context.textBaseline = 'alphabetic';
  }

  function draw(image, position, angle, course, worldWidth, worldHeight, originX, originY, lineLength, estimated,
    dayDistance, firstDayFraction, routePoints, routeDayInterval) {
    const imageAspect = image ? image.naturalWidth / image.naturalHeight : 2;
    if (imageAspect !== aspect) resize(width, height, imageAspect);
    const inputs = [image, position, angle, course, worldWidth, worldHeight, originX, originY, lineLength, estimated,
      dayDistance, firstDayFraction, routePoints, routePoints.length, routeDayInterval];
    if (!dirty && inputs.every((input, index) => Object.is(input, lastDraw[index]))) return;
    dirty = false;
    lastDraw = inputs;

    const tileHeight = height * zoom;
    const tileWidth = tileHeight * aspect;
    const xFor = point => left + wrap(point.x - originX, worldWidth) / worldWidth * tileWidth;
    const yFor = point => top + (point.y - originY) / worldHeight * tileHeight;
    const backdrop = [image, width, height, left, top, tileWidth, tileHeight,
      worldWidth, worldHeight, originX, originY, routePoints];
    if (routePoints.length < drawnRoutePoints || !backdrop.every((value, index) => value === backgroundInputs[index])) {
      backgroundInputs = backdrop;
      if (background.width !== width) background.width = width;
      if (background.height !== height) background.height = height;
      backgroundContext.fillStyle = '#091c27';
      backgroundContext.fillRect(0, 0, width, height);
      for (let x = left; x < width; x += tileWidth) {
        if (image) {
          const start = Math.round(x);
          const end = Math.round(x + tileWidth);
          backgroundContext.drawImage(image, start, top, end - start, tileHeight);
        } else {
          drawGrid(backgroundContext, x, tileWidth, tileHeight, worldWidth, originX);
        }
      }
      drawnRoutePoints = 0;
      routeDays.length = 0;
    }
    if (worldWidth > 0 && worldHeight > 0 && routePoints.length > drawnRoutePoints) {
      backgroundContext.save();
      backgroundContext.beginPath();
      backgroundContext.rect(0, top, width, tileHeight);
      backgroundContext.clip();
      for (let i = drawnRoutePoints; i < routePoints.length; i++) {
        if (routePoints[i].day !== null) routeDays.push(routePoints[i]);
      }
      backgroundContext.strokeStyle = routeColor;
      backgroundContext.lineWidth = 1.5;
      traceRoute(routePoints, drawnRoutePoints, backgroundContext, tileWidth, worldWidth, xFor, yFor);
      backgroundContext.stroke();
      backgroundContext.restore();
      drawnRoutePoints = routePoints.length;
    }
    context.drawImage(background, 0, 0);
    if (!(worldWidth > 0 && worldHeight > 0)) return;
    context.save();
    context.beginPath();
    context.rect(0, top, width, tileHeight);
    context.clip();
    if (plannedRoute?.length && worldWidth === 16384 && worldHeight === 8192) {
      drawPlannedRoute(tileWidth, worldWidth, xFor, yFor);
    }
    if (position) {
      const x = xFor(position);
      const y = yFor(position);
      if (Number.isFinite(lineLength)) {
        const bearings = [
          {angle: course, color: '#ffca80', dash: []},
          {angle: estimated ? null : angle, color: '#80efd0', dash: [8, 6]},
        ];
        for (const bearing of bearings) {
          if (bearing.angle === null) continue;
          const vector = directionVector(bearing.angle, lineLength);
          // Limit the direction line to one horizontal circuit for narrow custom worlds.
          const fraction = Math.abs(vector.x) > worldWidth ? worldWidth / Math.abs(vector.x) : 1;
          const dx = vector.x * fraction / worldWidth * tileWidth;
          const dy = vector.y * fraction / worldHeight * tileHeight;
          const dayStep = dayDistance / (lineLength * fraction);
          drawDirection(x, y, tileWidth, dx, dy, bearing.color, bearing.dash, dayStep, firstDayFraction);
        }
      }
      drawPosition(x, y, tileWidth, position, estimated);
    }
    drawRouteDays(routeDays, routeDayInterval, tileWidth, xFor, yFor);
    context.restore();
  }

  return {draw, showPlannedRoute};
}
