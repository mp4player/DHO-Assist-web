import {directionVector} from './vision.js';

const minZoom = 0.5;
const maxZoom = 8;
const zoomStep = 1.25;
const wrap = (value, period) => ((value % period) + period) % period;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createMapView(canvas, {zoomIn, zoomOut, reset, zoomLevel}) {
  const context = canvas.getContext('2d');
  let {width, height} = canvas;
  let aspect = 2;
  let zoom = 1;
  let left = 0;
  let top = 0;
  let drag = null;
  let dirty = true;
  let lastDraw = [];

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
    zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
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

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - canvas.clientLeft) * width / canvas.clientWidth,
      y: (event.clientY - bounds.top - canvas.clientTop) * height / canvas.clientHeight,
    };
  }

  zoomIn.onclick = () => zoomTo(zoom * zoomStep);
  zoomOut.onclick = () => zoomTo(zoom / zoomStep);
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

  function drawGrid(x, tileWidth, tileHeight, worldWidth, originX) {
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

  function drawDirection(x, y, tileWidth, dx, dy, color, dash) {
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
      context.arc(marker, y, 6, 0, Math.PI * 2);
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

  function draw(image, position, angle, course, worldWidth, worldHeight, originX, originY, lineLength, estimated = false) {
    const imageAspect = image ? image.naturalWidth / image.naturalHeight : 2;
    if (imageAspect !== aspect) resize(width, height, imageAspect);
    const inputs = [image, position, angle, course, worldWidth, worldHeight, originX, originY, lineLength, estimated];
    if (!dirty && inputs.every((input, index) => Object.is(input, lastDraw[index]))) return;
    dirty = false;
    lastDraw = inputs;

    const tileHeight = height * zoom;
    const tileWidth = tileHeight * aspect;
    context.fillStyle = '#091c27';
    context.fillRect(0, 0, width, height);
    for (let x = left; x < width; x += tileWidth) {
      if (image) {
        const start = Math.round(x);
        const end = Math.round(x + tileWidth);
        context.drawImage(image, start, top, end - start, tileHeight);
      } else {
        drawGrid(x, tileWidth, tileHeight, worldWidth, originX);
      }
    }
    if (!position || !(worldWidth > 0 && worldHeight > 0)) return;

    const x = left + wrap(position.x - originX, worldWidth) / worldWidth * tileWidth;
    const y = top + (position.y - originY) / worldHeight * tileHeight;
    context.save();
    context.beginPath();
    context.rect(0, top, width, tileHeight);
    context.clip();
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
        drawDirection(x, y, tileWidth, dx, dy, bearing.color, bearing.dash);
      }
    }
    drawPosition(x, y, tileWidth, position, estimated);
    context.restore();
  }

  return {draw};
}
