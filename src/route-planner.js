import {createPortLookup, routeWorld} from './route-search.js';
import {windSeasonAt} from './route-season.js';
import {createRouteProgress} from './route-progress.js';
import {createPlacePicker} from './route-place-picker.js';
import {createTransfers} from './route-transfers.js';

export function setupRoutePlanner({getPosition, getSettings, showRoute, knotsPerCoordinatePerSecond}) {
  const element = id => document.getElementById(id);
  const panel = element('routePanel');
  const form = element('routeForm');
  const start = createPlacePicker(element('routeStart'));
  const destination = createPlacePicker(element('routeDestination'));
  const submit = element('calculateRoute');
  const status = element('routeStatus');
  const summary = element('plannedRouteSummary');
  const estimate = element('plannedRouteEstimate');
  const objective = element('routeObjective');
  const season = element('routeSeason');
  const baseKnots = 10;
  const coordinatesPerMinute = baseKnots * 60 / knotsPerCoordinatePerSecond;
  const clear = element('clearPlannedRoute');
  const openHeadings = element('openRouteHeadings');
  const headingsDialog = element('routeHeadingsDialog');
  const headingList = element('routeHeadingList');
  const distance = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 0});
  const coordinate = new Intl.NumberFormat('ko-KR', {useGrouping: false, maximumFractionDigits: 1});
  const minutes = new Intl.NumberFormat('ko-KR', {maximumFractionDigits: 1});
  const arrivalTime = new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const transfersForm = element('routeTransferOptions');
  const transferFields = {
    automatic: element('routeAutoTransfer'), rail: element('routeRail'), tacoma: element('routeTacoma'),
    southeast: element('routeSoutheast'), east: element('routeEast'),
    canalCart: element('routeCanalCart'), camel: element('routeCamel'),
  };
  let places;
  let transferPlaces;
  let cities = [];
  let worker;
  let busy = false;
  let seaLegs = [];
  let plannedEstimate;
  let seasonTimer;
  let windSeason;
  let measuredFix = null;
  let measuredSpeed = null;
  start.setDisabled(true);
  destination.setDisabled(true);
  submit.disabled = true;

  function refreshEstimate() {
    if (!plannedEstimate || !windSeason) return;
    const {method, turns, wind, progress, remainingTransfers, arrivalInland, followed} = plannedEstimate;
    const stats = [{distance: '최단거리', turns: '최소 선회', balanced: '밸런스형'}[method], `선회 ${turns}회`];
    const {distance: sailed, equivalentDistance, unknownDistance} = wind[windSeason];
    const name = windSeason === 'summer' ? '하계' : '동계';
    if (progress.completed) {
      stats.push('항로 도착');
    } else if (equivalentDistance > 0) {
      const remaining = progress.remainingDistance(measuredFix);
      if (remaining !== null && measuredSpeed > 0) {
        const seconds = remaining / measuredSpeed;
        if (!remainingTransfers && !arrivalInland) stats.push(`예상 도착 ${arrivalTime.format(Date.now() + seconds * 1000)}`);
        stats.push(`남은 해상 시간 ${minutes.format(seconds / 60)}분 (실측 속도)`);
      } else if (remaining !== null && measuredSpeed === 0) {
        stats.push('예상 도착 — (정지)');
      } else if (measuredFix && remaining === null) {
        stats.push('예상 도착 — (항로 확인 대기)');
      } else if (followed) {
        stats.push('예상 도착 — (실측 대기)');
      } else {
        stats.push(`${name} 해역·풍향 보정 속도 ${distance.format(100 * sailed / equivalentDistance)}%`);
        stats.push(`예상 해상 시간 ${minutes.format(equivalentDistance / coordinatesPerMinute)}분 (기준 ${baseKnots} knot)`);
        if (unknownDistance > .1) stats.push(`풍향 미상 ${distance.format(unknownDistance)}좌표`);
      }
    }
    const text = stats.join(' · ');
    if (estimate.textContent !== text) estimate.textContent = text;
  }

  function updateSeason() {
    const now = Date.now();
    const {season: current, nextChange} = windSeasonAt(now);
    windSeason = current;
    const name = windSeason === 'summer' ? '하계' : '동계';
    if (season.value !== `${name} (자동)`) season.value = `${name} (자동)`;
    refreshEstimate();
    clearTimeout(seasonTimer);
    if (panel.open || plannedEstimate) seasonTimer = setTimeout(updateSeason, Math.min(nextChange - now, 60_000));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateSeason();
  });

  function updateNavigation(fix, speed) {
    measuredFix = fix;
    measuredSpeed = speed;
    if (!plannedEstimate) return;
    const {progress} = plannedEstimate;
    if (progress.observe(fix)) {
      const remaining = progress.remainingLegs();
      plannedEstimate.remainingTransfers = remaining.some(leg => leg.mode !== '해상');
      showRoute(remaining, false);
      seaLegs = remaining.filter(leg => leg.headings?.length);
      openHeadings.hidden = !seaLegs.length;
    }
    if (progress.advanced || progress.remainingDistance(fix) !== null) plannedEstimate.followed = true;
    refreshEstimate();
  }

  openHeadings.onclick = () => {
    const sections = document.createDocumentFragment();
    for (const leg of seaLegs) {
      const title = document.createElement('h3');
      title.textContent = leg.names.join(' → ');
      const list = document.createElement('ol');
      for (const [index, heading] of leg.headings.entries()) {
        const {x, y} = leg.points[index];
        const row = document.createElement('li');
        row.textContent = `${coordinate.format(x)} / ${coordinate.format(y)}에서 ${heading}°`;
        list.append(row);
      }
      sections.append(title, list);
    }
    headingList.replaceChildren(sections);
    headingsDialog.showModal();
  };

  async function loadPlaces() {
    const [{default: data}, {default: coast}] = await Promise.all([
      import('../../DB/cities.json'), import('../../DB/landings.json'),
    ]);
    if (data.coordinateSystem.width !== routeWorld.width || data.coordinateSystem.height !== routeWorld.height ||
        !data.coordinateSystem.wrapX) throw new Error('City coordinates do not match the route map');
    places = createPortLookup(data.cities);
    transferPlaces = new Map([...data.cities, ...coast.landings].map(place => [place.name, place]));
    cities = [[false, '항구'], [true, '내륙 도시']].flatMap(([inland, category]) => [...places]
      .filter(([, place]) => place.inland === inland)
      .map(([id, place]) => ({id, name: place.name, category})));
    destination.setItems(cities);
    updateDepartureChoices();
  }

  function updateDepartureChoices() {
    start.setItems(getPosition() ? [{id: 'current', name: '현재 측량 위치'}, ...cities] : cities);
  }

  function calculate(departures, arrivals, transfers, method) {
    return new Promise((resolve, reject) => {
      worker ??= new Worker(new URL('./route-worker.js', import.meta.url), {type: 'module'});
      worker.onmessage = ({data}) => data.error ? reject(new Error('Route calculation failed')) : resolve(data.route);
      worker.onerror = error => {
        worker.terminate();
        worker = null;
        reject(error);
      };
      worker.postMessage({departures, arrivals, transfers, objective: method, season: windSeasonAt(Date.now()).season});
    });
  }

  function setBusy(value) {
    busy = value;
    start.setDisabled(value);
    destination.setDisabled(value);
    objective.disabled = submit.disabled = value;
    updateTransferOptions();
  }

  function updateTransferOptions() {
    transferFields.automatic.disabled = busy;
    element('routeTransferModes').disabled = busy || !transferFields.automatic.checked;
    element('routeRailOptions').disabled = !transferFields.rail.checked;
    element('routeCanalCartOptions').disabled = !transferFields.canalCart.checked;
  }
  transfersForm.onchange = updateTransferOptions;
  updateTransferOptions();

  panel.ontoggle = async () => {
    updateSeason();
    if (!panel.open) return;
    updateDepartureChoices();
    status.textContent = busy ? status.textContent : '';
    if (places || busy) return;
    setBusy(true);
    status.textContent = '항구 목록 불러오는 중…';
    try {
      await loadPlaces();
      status.textContent = '';
    } catch (error) {
      console.error(error);
      status.textContent = '항구 목록을 불러오지 못했습니다.';
    } finally {
      setBusy(false);
    }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !places) return;
    const settings = getSettings();
    if (Number(settings.worldWidth) !== routeWorld.width || Number(settings.worldHeight) !== routeWorld.height) {
      status.textContent = '자동 항로에는 세계 좌표 크기 16384 × 8192가 필요합니다.';
      return;
    }
    const departureId = start.value, arrivalId = destination.value;
    if (!departureId || !arrivalId) {
      status.textContent = '출발지와 목적지를 목록에서 선택하세요.';
      return;
    }
    if (departureId === arrivalId) {
      status.textContent = '출발지와 목적지를 다르게 선택하세요.';
      return;
    }
    const point = getPosition();
    if (departureId === 'current' && !point) {
      status.textContent = '현재 측량 위치를 읽을 수 없습니다. 출발 항구를 선택하세요.';
      return;
    }
    const method = objective.value;
    setBusy(true);
    status.textContent = '항로 계산 중…';
    try {
      const options = Object.fromEntries(Object.entries(transferFields).map(([key, field]) => [key, field.checked]));
      const transfers = createTransfers(transferPlaces, options);
      function endpoints(cityId) {
        const city = places.get(cityId);
        if (city.inland && transfers.stops.some(stop => stop.name === city.name)) {
          return [{stop: city.name, names: [city.name]}];
        }
        return city.ports;
      }
      const departures = departureId === 'current' ? [{point, names: ['현재 측량 위치']}] : endpoints(departureId);
      const arrivals = endpoints(arrivalId);
      const route = await calculate(departures, arrivals, transfers, method);
      if (!route) {
        status.textContent = '연결된 해상 항로를 찾지 못했습니다.';
        return;
      }
      const from = route.departure.names;
      const to = [...route.arrival.names].reverse();
      const land = [from, to].filter(names => names.length > 1).map(names => names.join(' → '));
      const path = route.legs.map(leg => {
        if (leg.distance === 0) return `해상 ${leg.names.at(-1)} (같은 해상 접근점)`;
        const length = leg.distance ? ` (${distance.format(leg.distance)} 좌표)` : '';
        return `${leg.mode} ${leg.names.join(' → ')}${length}`;
      });
      summary.textContent = [...path, ...land.map(section => `육상 연결 ${section}`)].join(' · ');
      showRoute(route.legs);
      seaLegs = route.legs.filter(leg => leg.headings?.length);
      openHeadings.hidden = !seaLegs.length;
      const turns = seaLegs.reduce((sum, leg) => sum + leg.turns, 0);
      plannedEstimate = {method, turns, wind: route.wind, progress: createRouteProgress(route.legs, routeWorld.width),
        remainingTransfers: route.legs.some(leg => leg.mode !== '해상'), arrivalInland: to.length > 1};
      updateSeason();
      updateNavigation(measuredFix, measuredSpeed);
      estimate.hidden = false;
      element('plannedRouteBar').hidden = false;
      status.textContent = '';
    } catch (error) {
      console.error(error);
      status.textContent = '항로를 계산하지 못했습니다. 다시 시도해 주세요.';
    } finally {
      setBusy(false);
    }
  };

  clear.onclick = () => {
    showRoute(null);
    plannedEstimate = null;
    updateSeason();
    seaLegs = [];
    headingList.replaceChildren();
    openHeadings.hidden = true;
    estimate.textContent = '';
    estimate.hidden = true;
    summary.textContent = '';
    element('plannedRouteBar').hidden = true;
  };

  return {updateNavigation};
}
