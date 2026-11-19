import './style.css';
import {createWorker,PSM} from 'tesseract.js';
import {parseCoordinates,compassAngle,gameHudRegions,gameCompassAngle,readSurveyText,appendMotionSamples,measureAverageMotion,readSailingDay,findSailingDay,updateSailingClock,nextSailingDayFraction,estimatePosition,shouldEstimatePosition} from './vision.js';
import {createMapView} from './map.js';
import {setupRoutePlanner} from './route-planner.js';
const $=id=>document.getElementById(id), capture=$('capture'), video=$('video');
const compassCapture = $('compassCapture');
const compassVideo = $('compassVideo');
let compassStream = null;
let compassUsesGameHud = false;
let compassVersion = 0;
const demoFrame = document.createElement('canvas');
demoFrame.width = 960;
demoFrame.height = 540;
const fc = demoFrame.getContext('2d');
const sailingCrop = document.createElement('canvas');
const previewIntervalMs = 1000 / 15;
let lastPreviewTime = -Infinity;
const defaultMapImage = new Image();
defaultMapImage.src = `${import.meta.env.BASE_URL}worldmap_0.png`;
const mapView = createMapView($('map'), {
  zoomIn: $('mapZoomIn'),
  zoomOut: $('mapZoomOut'),
  reset: $('mapReset'),
  zoomLevel: $('mapZoomLevel'),
});
const sidebarToggle = $('toggleMapSidebar');
const sidebarBody = $('mapSidebarBody');
sidebarToggle.onclick = () => {
  sidebarBody.hidden = !sidebarBody.hidden;
  sidebarToggle.setAttribute('aria-expanded', String(!sidebarBody.hidden));
  sidebarToggle.setAttribute('aria-label', sidebarBody.hidden ? '지도 도구 펼치기' : '지도 도구 접기');
  sidebarToggle.textContent = sidebarBody.hidden ? '›' : '‹';
  if (sidebarBody.hidden && selecting) cancelSelection();
};
document.addEventListener('pointermove', event => {
  const bounds = sidebarToggle.getBoundingClientRect();
  const distance = Math.hypot(event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2);
  sidebarToggle.style.setProperty('--proximity', Math.max(0, 1 - distance / 110));
}, {passive: true});
document.addEventListener('pointerleave', () => sidebarToggle.style.setProperty('--proximity', 0));
let source=null,stream=null,draftRegions={},selecting=null,start=null,drag=null,busy=false,running=false,workerPromise=null,position=null,angle=null,generation=0,lastTick=0;
let useGameHud = false;
const motionSamples = [];
const routePoints = [];
let lastRouteSignalTime = -Infinity;
let lastRouteDay = null;
let previousMotionFix = null;
let averageMotion = null;
let trackingSince = Infinity;
const maxFixGap = 6000;
const routeSampleIntervalMs = 1000;
const predictionWindowMs = 20_000;
const sailingTimeoutMs = 5000;
const sailingSearchIntervalMs = 1000;
const secondsPerSailingDay = 60;
// WGS 84 equatorial circumference across 16,384 coordinates, in nautical miles.
const nauticalMilesPerCoordinate = 2 * Math.PI * 6_378_137 / 16_384 / 1852;
const gameKnotsPerCoordinatePerSecond = nauticalMilesPerCoordinate * secondsPerSailingDay / 24;
const predictionKnotsPerCoordinatePerSecond = 3.3014197;
let sailingDayRegion = null;
let sailingClock = null;
let lastSailingSearch = -Infinity;
const sailingDayOutput = $('sailingDay');
const coordinateAttempts = [];
let lastMeasuredPosition = null;
let lastMeasuredCourse = null;
let predictionFix = null;
let estimatedPosition = null;
let estimatedPositionTime = 0;
function message(text) {
  $('message').textContent = text;
  $('screenMessage').textContent = text;
}
const defaultSelectionHint = $('selectionHint').textContent;
const autoRegionHint = '게임 화면 오른쪽 아래의 측량 좌표와 나침반 영역을 자동으로 사용합니다.';
const settingsDialog = $('settingsDialog');
const capturePanel = $('capturePanel');
const recognitionPanel = $('recognitionPanel');
const generalPanel = $('generalPanel');
const recognitionFps = $('recognitionFps');
const recognitionFpsSlider = $('recognitionFpsSlider');
const motionAverageSeconds = $('motionAverageSeconds');
const maxMotionWindowMs = Number(motionAverageSeconds.max) * 1000;
const settingsFields = [...settingsDialog.querySelectorAll('.settings input:not(#recognitionFpsSlider), .settings select')];
const defaultValues = readSettings();
const settingsKey = 'dho-assist.settings.v1';
const recognitionKeys = ['preprocess', 'confidence', 'offset', 'worldWidth', 'worldHeight'];
let savedValues = restoreSettings();
function applySidebarPosition() {
  $('mapSidebar').dataset.arrowPosition = savedValues.sidebarArrowPosition;
}
applySidebarPosition();
const routePlanner = setupRoutePlanner({
  getPosition: () => source === 'video' ? position : null,
  getSettings: () => savedValues,
  knotsPerCoordinatePerSecond: gameKnotsPerCoordinatePerSecond,
  showRoute: (legs, fit) => mapView.showPlannedRoute(legs, savedValues, fit),
});
let draftValues = savedValues;
let savedRegions = {};
let savedMap = null;
let draftMap = null;
let loadingMap = false;
let savedResult = null;
let previewBearing = null;
let previewVersion = 0;
let previewRequested = false;
let liveRequested = false;
const settingsTabs = [...$('settingsTabs').querySelectorAll('[role="tab"]')];
for (const group of document.querySelectorAll('[data-share-controls]')) {
  group.append($('sharingControls').content.cloneNode(true));
}
const shareStarts = document.querySelectorAll('[data-share-start]');
const shareStops = document.querySelectorAll('[data-share-stop]');
const compassShareButtons = document.querySelectorAll('[data-compass-share]');
const shareStatuses = document.querySelectorAll('[data-share-status]');
let pendingShare = null;
let mapImageRequest = 0;
const demoRegions = {
  coord: {x: 36, y: 30, w: 365, h: 78},
  compass: {x: 772, y: 30, w: 140, h: 140},
};
// On Windows, Firefox window sharing includes extra pixels beyond the game client.
const firefoxWindowInsets = /\bWindows NT\b/.test(navigator.userAgent) && /\bFirefox\//.test(navigator.userAgent)
  ? {right: 4, bottom: 5} : undefined;

function readSettings() {
  return Object.fromEntries(settingsFields.map(field => [field.id, fieldSetting(field)]));
}

function fieldSetting(field) {
  return field.type === 'checkbox' ? field.checked : field.value;
}

function writeSettings(values, form) {
  for (const field of settingsFields) {
    if (form && field.form !== form) continue;
    if (field.type === 'checkbox') field.checked = values[field.id];
    else field.value = values[field.id];
  }
  syncSettingsControls();
}

function syncSettingsControls() {
  if (recognitionFps.validity.valid) recognitionFpsSlider.value = recognitionFps.value;
  $('motionAverageValue').textContent = `${motionAverageSeconds.value}초`;
  const variableLength = $('lineLengthMode').value === 'days';
  $('fixedLineLength').hidden = variableLength;
  $('sailingLineLength').hidden = !variableLength;
  $('lineDaysHint').hidden = !variableLength;
  $('adjustSailingTime').disabled = !$('showDayArrows').checked;
}

function restoreSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(settingsKey));
    if (!stored) return defaultValues;
    writeSettings({...defaultValues, ...stored});
    if (settingsFields.every(field => field.value !== '' && field.validity.valid)) return readSettings();
  } catch {
    // The app can still use settings for the current page when storage is unavailable.
  }
  writeSettings(defaultValues);
  return defaultValues;
}

function samePrimaryRegions(left, right) {
  return JSON.stringify(left.coord) === JSON.stringify(right.coord)
    && JSON.stringify(left.compass) === JSON.stringify(right.compass);
}

function sameExtraCompass(left, right) {
  return JSON.stringify(left.extraCompass) === JSON.stringify(right.extraCompass);
}

function sameRegions(left, right) {
  return samePrimaryRegions(left, right) && sameExtraCompass(left, right);
}

function hasRegions(value) {
  return Boolean(value.coord && (compassStream || value.compass));
}

function previewDiffers() {
  return recognitionKeys.some(key => draftValues[key] !== savedValues[key]) || !sameRegions(draftRegions, savedRegions);
}

function updateSettingsButtons() {
  $('settingsChanges').hidden = !loadingMap && draftMap === savedMap
    && sameRegions(draftRegions, savedRegions) && settingsFields.every(field => fieldSetting(field) === savedValues[field.id]);
  $('saveSettings').disabled = loadingMap;
  $('mapFileName').textContent = draftMap?.name ?? '기본 지도';
}

function refreshPreview() {
  previewVersion++;
  previewRequested = previewDiffers() && hasRegions(draftRegions) && Boolean(source);
  showPreview(previewDiffers() ? null : savedResult);
}

function editSettings() {
  const previous = draftValues;
  const mode = $('lineLengthMode').value;
  if (mode !== previous.lineLengthMode) {
    const inactiveLength = $(mode === 'days' ? 'lineLength' : 'lineDays');
    if (!inactiveLength.validity.valid) inactiveLength.value = savedValues[inactiveLength.id];
  }
  syncSettingsControls();
  draftValues = readSettings();
  if (recognitionKeys.some(key => previous[key] !== draftValues[key])) refreshPreview();
  if (previous.bearingStep !== draftValues.bearingStep) showPreviewBearing();
  updateSettingsButtons();
}

for (const field of settingsFields) field.addEventListener('input', editSettings);
recognitionFpsSlider.addEventListener('input', () => {
  recognitionFps.value = recognitionFpsSlider.value;
  editSettings();
});

$('saveSettings').onclick = () => {
  if (loadingMap) return;
  for (const tab of settingsTabs) {
    const panel = $(tab.getAttribute('aria-controls'));
    if (panel.checkValidity()) continue;
    selectSettingsTab(tab);
    panel.reportValidity();
    return;
  }
  const changedRecognition = recognitionKeys.some(key => draftValues[key] !== savedValues[key])
    || !samePrimaryRegions(draftRegions, savedRegions);
  const changedCompass = !sameExtraCompass(draftRegions, savedRegions);
  const changedMotionWindow = savedValues.motionAverageSeconds !== draftValues.motionAverageSeconds;
  savedValues = draftValues;
  savedRegions = {...draftRegions};
  savedMap = draftMap;
  applySidebarPosition();
  try {
    localStorage.setItem(settingsKey, JSON.stringify(savedValues));
    message('변경사항을 저장하고 적용했습니다.');
  } catch {
    message('변경사항을 적용했습니다. 브라우저 저장소에 기록할 수 없어 이 페이지에서만 유지됩니다.');
  }
  if (changedRecognition) {
    if (running && source !== 'video' && !hasRegions(savedRegions)) setTracking(false);
    resetRecognition();
    liveRequested = Boolean(source) && hasRegions(savedRegions);
    if (liveRequested) showMapShareMessage();
  } else if (changedMotionWindow) {
    showAverageMotion(Number(savedValues.worldWidth));
  }
  if (changedCompass) refreshCompassRecognition();
  showMapBearings();
  showSpeed();
  updateSettingsButtons();
};

$('cancelSettings').onclick = () => {
  mapImageRequest++;
  loadingMap = false;
  $('mapFile').value = '';
  draftMap = savedMap;
  draftValues = savedValues;
  writeSettings(savedValues);
  draftRegions = {...savedRegions};
  cancelSelection();
  refreshPreview();
  updateSettingsButtons();
  message('마지막으로 저장한 설정으로 돌아갔습니다.');
};

function setSourceLabel(text) {
  const sharing = source === 'video';
  const overview = $('recognitionShareControls');
  const focused = document.activeElement;
  overview.hidden = sharing;
  for (const button of shareStarts) button.textContent = sharing ? '게임 화면 변경' : '게임 화면 공유';
  for (const button of shareStops) button.hidden = !sharing;
  updateShareButtons();
  for (const status of shareStatuses) status.textContent = text;

  if (sharing && overview.contains(focused)) $('track').focus();
  if (!sharing && focused?.matches('[data-share-stop]')) {
    const startButton = focused.parentElement.querySelector('[data-share-start]');
    (startButton.disabled ? $('captureTab') : startButton).focus();
  }
}

function updateShareButtons() {
  for (const button of shareStarts) button.disabled = Boolean(pendingShare);
  for (const button of compassShareButtons) {
    button.hidden = source !== 'video';
    button.disabled = Boolean(pendingShare);
    button.textContent = compassStream ? '나침반 화면 공유 취소' : '나침반 화면 추가';
  }
  $('compassScreen').hidden = !compassStream || source !== 'video';
}

function selectSettingsTab(activeTab) {
  for (const tab of settingsTabs) {
    const active = tab === activeTab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (capturePanel.hidden && selecting) cancelSelection();
  $('resetSettings').setAttribute('form', activeTab.getAttribute('aria-controls'));
  $('settingsBody').scrollTop = 0;
}

for (const tab of settingsTabs) tab.onclick = () => selectSettingsTab(tab);
$('settingsTabs').onkeydown = event => {
  const index = settingsTabs.indexOf(event.target);
  if (index < 0) return;
  let next;
  switch (event.key) {
    case 'ArrowLeft': next = settingsTabs[(index + settingsTabs.length - 1) % settingsTabs.length]; break;
    case 'ArrowRight': next = settingsTabs[(index + 1) % settingsTabs.length]; break;
    case 'Home': next = settingsTabs[0]; break;
    case 'End': next = settingsTabs.at(-1); break;
    default: return;
  }
  event.preventDefault();
  selectSettingsTab(next);
  next.focus();
};
$('openSettings').onclick = () => {
  selectSettingsTab(settingsTabs[0]);
  settingsDialog.showModal();
  if (previewDiffers()) refreshPreview();
};
settingsDialog.addEventListener('close', () => { if (selecting) cancelSelection(); });
$('closeSettings').onclick = $('closeSettingsTop').onclick = () => settingsDialog.close();

function showMotion(motion = null) {
  averageMotion = motion;
  if (motion?.course != null) lastMeasuredCourse = motion.course;
  showSpeed();
  showCourseBearing();
}

function showSpeed() {
  const inKnots = savedValues.speedUnit === 'knot';
  const multiplier = inKnots ? gameKnotsPerCoordinatePerSecond : 60;
  const unit = inKnots ? 'knot' : '좌표/분';
  const label = $('speedUnitLabel');
  if (label.textContent !== unit) label.textContent = unit;
  $('speed').textContent = averageMotion ? (averageMotion.speed * multiplier).toFixed(1) : '—';
}

function roundBearing(bearing, step) {
  if (bearing === null) return null;
  const units = 1 / step;
  return ((Math.round(bearing * units) % (360 * units)) / units);
}

function formatBearing(bearing, step) {
  const rounded = roundBearing(bearing, step);
  return rounded === null ? '—°' : `${rounded.toFixed(step < 1 ? 1 : 0)}°`;
}

function showMapBearings() {
  $('heading').textContent = formatBearing(angle, Number(savedValues.bearingStep));
  showCourseBearing();
}

function showCourseBearing() {
  const displayCourse = estimatedPosition ? lastMeasuredCourse : averageMotion?.course ?? null;
  const text = formatBearing(displayCourse, Number(savedValues.bearingStep));
  if ($('course').textContent !== text) $('course').textContent = text;
}

function showPreviewBearing() {
  $('previewHeading').textContent = formatBearing(previewBearing, Number(draftValues.bearingStep));
}

function clearMotion() {
  motionSamples.length = 0;
  previousMotionFix = null;
  showMotion();
  routePlanner.updateNavigation(null, null);
}

function showAverageMotion(worldWidth) {
  const windowMs = Number(savedValues.motionAverageSeconds) * 1000;
  showMotion(measureAverageMotion(motionSamples, windowMs, worldWidth));
}

function clearPrediction() {
  coordinateAttempts.length = 0;
  lastMeasuredPosition = null;
  lastMeasuredCourse = null;
  sailingDayRegion = null;
  sailingClock = null;
  lastSailingSearch = -Infinity;
  showSailingDay();
  breakRoute();
  predictionFix = null;
  estimatedPosition = null;
  $('estimatedLocation').hidden = true;
  showCourseBearing();
}

function sailingDayIsCurrent(time) {
  return sailingClock !== null && time - sailingClock.time <= sailingTimeoutMs;
}

function showSailingDay(day = null) {
  const text = day === null ? '—' : `${day}일`;
  if (sailingDayOutput.textContent !== text) sailingDayOutput.textContent = text;
}

function breakRoute() {
  lastRouteSignalTime = -Infinity;
  lastRouteDay = null;
}

function recordRouteFix(fix, day, time) {
  if (day !== null && lastRouteDay !== null && day < lastRouteDay) breakRoute();
  const previous = routePoints.at(-1);
  const start = !previous || time - lastRouteSignalTime > maxFixGap;
  if (!fix) {
    // A visible sailing counter keeps the voyage continuous during a survey outage.
    if (day !== null && !start) lastRouteSignalTime = time;
    return;
  }
  const markDay = day > 0 && day !== lastRouteDay;
  if (start || markDay || (time - previous.time >= routeSampleIntervalMs
    && (fix.x !== previous.x || fix.y !== previous.y))) {
    routePoints.push({...fix, start, day: markDay ? day : null, time});
  }
  lastRouteSignalTime = time;
  if (day !== null) lastRouteDay = day;
}

function rememberPredictionFix(time, worldWidth) {
  const speed = measureAverageMotion(motionSamples, predictionWindowMs, worldWidth)?.speed ?? 0;
  const knots = speed * predictionKnotsPerCoordinatePerSecond;
  const direction = compassStream ? averageMotion?.course ?? null : angle;
  predictionFix = direction !== null && knots >= 1 && knots < 100 ? {position, angle: direction, speed, time} : null;
}

function updateEstimatedPosition(time, worldWidth, worldHeight, estimateRequested) {
  if (!sailingDayIsCurrent(time)) {
    predictionFix = null;
  }
  const wasEstimated = Boolean(estimatedPosition);
  if (!predictionFix || !estimateRequested || time < predictionFix.time) {
    estimatedPosition = null;
  } else if (!estimatedPosition || time - estimatedPositionTime >= 200) {
    estimatedPosition = estimatePosition(predictionFix, (time - predictionFix.time) / 1000, worldWidth, worldHeight);
    estimatedPositionTime = time;
  }
  $('estimatedLocation').hidden = !estimatedPosition;
  if (wasEstimated !== Boolean(estimatedPosition)) showCourseBearing();
}

function updateMotion(fix, time, worldWidth) {
  if (!fix || source !== 'video' || !running || time < trackingSince) {
    clearMotion();
    return;
  }
  const previous = previousMotionFix;
  const current = {position: fix, time};
  if (!previous || time <= previous.time || time - previous.time > maxFixGap) {
    clearMotion();
    previousMotionFix = current;
    motionSamples.push(current);
    return;
  }
  previousMotionFix = current;
  if (!appendMotionSamples(motionSamples, previous, current, worldWidth)) return;
  while (motionSamples[1]?.time <= motionSamples.at(-1).time - maxMotionWindowMs) motionSamples.shift();
  showAverageMotion(worldWidth);
}

function recordCoordinateAttempt(time, worldWidth) {
  const previousAttempt = coordinateAttempts.at(-1);
  if (previousAttempt && time - previousAttempt.time > maxFixGap) coordinateAttempts.length = 0;
  coordinateAttempts.push({time, failed: !position});
  while (coordinateAttempts[0].time < time - maxMotionWindowMs) coordinateAttempts.shift();

  if (position) {
    lastMeasuredPosition = position;
    updateMotion(position, time, worldWidth);
    if (sailingDayIsCurrent(time)) rememberPredictionFix(time, worldWidth);
  } else if (estimateRequested()) {
    clearMotion();
  }
}

function estimateRequested() {
  return !position && shouldEstimatePosition(coordinateAttempts, Number(savedValues.motionAverageSeconds) * 1000);
}

function resetRecognition() {
  generation++;
  position = null;
  angle = null;
  savedResult = null;
  liveRequested = false;
  clearMotion();
  clearPrediction();
  $('heading').textContent = '—°';
  refreshPreview();
}

function cancelSelection() {
  start = null;
  drag = null;
  selecting = null;
  capture.classList.remove('selecting');
  compassCapture.classList.remove('selecting');
  $('selectionHint').textContent = compassStream ? '측량 좌표는 기본 게임 화면에서, 나침반은 추가 화면에서 인식합니다.'
    : draftRegions.coord?.gameHud && draftRegions.compass?.gameHud ? autoRegionHint : defaultSelectionHint;
}

function resetCaptureRegions() {
  running = false;
  trackingSince = Infinity;
  $('track').textContent = '연속 인식 시작';
  draftRegions = {extraCompass: draftRegions.extraCompass};
  savedRegions = {extraCompass: savedRegions.extraCompass};
  cancelSelection();
  for (const id of ['coordCrop', 'compassCrop']) {
    const canvas = $(id);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  resetRecognition();
  updateSettingsButtons();
}

function stopSource({keepCompass = false} = {}) {
  if (!keepCompass && pendingShare) pendingShare.cancelled = true;
  if (!keepCompass) stopCompassSharing();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  source = null;
  useGameHud = false;
  $('autoRegions').disabled = true;
  resetCaptureRegions();
  setSourceLabel('연결 대기');
  showMapShareMessage();
}
function setSize(w,h){
  capture.width = w;
  capture.height = h;
  lastPreviewTime = -Infinity;
}
function defaultRegions() {
  if (source === 'demo') return {...demoRegions};
  const primary = useGameHud
    ? gameHudRegions(capture.width, capture.height, source === 'video' ? firefoxWindowInsets : undefined)
    : {};
  return {...primary, extraCompass: defaultExtraCompassRegion()};
}

function defaultExtraCompassRegion() {
  if (!compassStream || !compassUsesGameHud) return;
  return gameHudRegions(compassVideo.videoWidth, compassVideo.videoHeight, firefoxWindowInsets).compass;
}

function setSourceRegions() {
  const regions = defaultRegions();
  draftRegions = {...regions, extraCompass: draftRegions.extraCompass ?? regions.extraCompass};
  savedRegions = {...regions, extraCompass: savedRegions.extraCompass ?? regions.extraCompass};
  $('autoRegions').disabled = !useGameHud && !compassUsesGameHud;
  cancelSelection();
  refreshPreview();
  updateSettingsButtons();
}

$('autoRegions').onclick = () => {
  draftRegions = defaultRegions();
  cancelSelection();
  refreshPreview();
  updateSettingsButtons();
  message('게임 기본 영역을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
};

recognitionPanel.onsubmit = event => event.preventDefault();
recognitionPanel.onreset = event => {
  event.preventDefault();
  mapImageRequest++;
  loadingMap = false;
  draftMap = null;
  $('mapFile').value = '';
  writeSettings(defaultValues, recognitionPanel);
  editSettings();
  message('인식 보정과 지도 기본값을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
};

generalPanel.onsubmit = event => event.preventDefault();
generalPanel.onreset = event => {
  event.preventDefault();
  writeSettings(defaultValues, generalPanel);
  editSettings();
};

capturePanel.onreset = () => {
  draftRegions = defaultRegions();
  cancelSelection();
  refreshPreview();
  updateSettingsButtons();
  message(source && !hasRegions(draftRegions)
    ? '초기화하면 이 화면의 인식 영역을 다시 지정해야 합니다.'
    : '기본 인식 영역을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
};

function showMapShareMessage(text = '') {
  const status = $('mapShareMessage');
  status.textContent = text;
  status.hidden = !text;
}

async function startSharing(event) {
  if (pendingShare) return;
  const fromMap = event.currentTarget === $('mapShare');
  showMapShareMessage();
  const report = text => {
    message(text);
    if (fromMap) showMapShareMessage(text);
  };
  if (!navigator.mediaDevices?.getDisplayMedia) {
    report('화면 공유를 지원하는 데스크톱 브라우저에서 HTTPS 또는 localhost로 접속하세요.');
    return;
  }
  const request = {cancelled: false};
  pendingShare = request;
  updateShareButtons();
  let next;
  try {
    next = await navigator.mediaDevices.getDisplayMedia({video: {displaySurface: 'window'}, audio: false});
    if (request.cancelled) {
      next.getTracks().forEach(track => track.stop());
      return;
    }
    stopSource({keepCompass: true});
    stream = next;
    const [track] = next.getVideoTracks();
    track.addEventListener('ended', () => {
      if (stream === next) {
        stopSource();
        message('화면 공유가 종료되었습니다.');
      }
    });
    video.srcObject = next;
    await video.play();
    if (stream !== next) return;
    setSize(video.videoWidth, video.videoHeight);
    source = 'video';
    const {displaySurface} = track.getSettings();
    useGameHud = !displaySurface || displaySurface === 'window';
    setSourceRegions();
    setTracking(true);
    setSourceLabel('게임 화면 공유 중');
    if (hasRegions(savedRegions)) {
      message('연속 인식을 시작했습니다. 게임에서 측량을 켜세요.');
    } else {
      report('설정의 화면 및 영역 탭에서 좌표와 나침반 영역을 지정하고 저장하면 인식이 시작됩니다.');
    }
  } catch (error) {
    if (request.cancelled || (next && stream !== next)) return;
    if (next) stopSource();
    report('화면 공유를 시작하지 못했습니다: ' + error.message);
  } finally {
    pendingShare = null;
    updateShareButtons();
  }
}

function refreshCompassRecognition() {
  compassVersion++;
  angle = null;
  predictionFix = null;
  if (savedResult) savedResult = {...savedResult, angle: null};
  showMapBearings();
  refreshPreview();
  liveRequested = Boolean(source) && hasRegions(savedRegions);
}

function stopCompassSharing() {
  if (!compassStream) return;
  compassStream.getTracks().forEach(track => track.stop());
  compassStream = null;
  compassUsesGameHud = false;
  compassVideo.srcObject = null;
  delete draftRegions.extraCompass;
  delete savedRegions.extraCompass;
  $('autoRegions').disabled = !useGameHud;
  cancelSelection();
  refreshCompassRecognition();
  updateSettingsButtons();
  updateShareButtons();
}

function applyExtraCompassRegion() {
  compassCapture.width = compassVideo.videoWidth;
  compassCapture.height = compassVideo.videoHeight;
  lastPreviewTime = -Infinity;
  savedRegions.extraCompass = draftRegions.extraCompass = defaultExtraCompassRegion();
  $('autoRegions').disabled = !useGameHud && !compassUsesGameHud;
  cancelSelection();
  refreshCompassRecognition();
  updateSettingsButtons();
}

async function toggleCompassSharing(event) {
  if (source !== 'video' || pendingShare) return;
  const fromMap = event.currentTarget === $('mapCompassShare');
  const report = text => {
    message(text);
    if (fromMap) showMapShareMessage(text);
  };
  showMapShareMessage();
  if (compassStream) {
    stopCompassSharing();
    report('기본 게임 화면에서 측량 좌표와 나침반을 인식합니다.');
    return;
  }
  const request = {cancelled: false};
  pendingShare = request;
  updateShareButtons();
  let next;
  try {
    next = await navigator.mediaDevices.getDisplayMedia({video: {displaySurface: 'window'}, audio: false});
    const [track] = next.getVideoTracks();
    if (request.cancelled) return;
    compassVideo.srcObject = next;
    await compassVideo.play();
    if (request.cancelled || track.readyState === 'ended') return;
    compassStream = next;
    const {displaySurface} = track.getSettings();
    compassUsesGameHud = !displaySurface || displaySurface === 'window';
    track.addEventListener('ended', () => {
      if (compassStream !== next) return;
      stopCompassSharing();
      report('나침반 공유가 종료되어 기본 게임 화면으로 돌아갔습니다.');
    });
    applyExtraCompassRegion();
    report(savedRegions.extraCompass ? '추가 화면에서 나침반을 인식합니다.'
      : '화면 및 영역 탭에서 추가 화면의 나침반 영역을 지정하고 저장하세요.');
  } catch (error) {
    if (!request.cancelled) report('나침반 화면을 공유하지 못했습니다: ' + error.message);
  } finally {
    if (next && compassStream !== next) {
      next.getTracks().forEach(track => track.stop());
      if (compassVideo.srcObject === next) compassVideo.srcObject = null;
    }
    pendingShare = null;
    updateShareButtons();
  }
}

for (const button of compassShareButtons) button.onclick = toggleCompassSharing;

for (const button of shareStarts) button.onclick = startSharing;
for (const button of shareStops) {
  button.onclick = () => {
    stopSource();
    message('공유와 인식을 종료했습니다.');
  };
}
async function loadImage(file){const url=URL.createObjectURL(file);try{const image=new Image();image.src=url;await image.decode();return image;}finally{URL.revokeObjectURL(url);}}
$('image').onchange = async event => {
  const input = event.target;
  const [file] = input.files;
  if (!file) return;
  try {
    const image = await loadImage(file);
    if (input.files[0] !== file) return;
    stopSource();
    setSize(image.width, image.height);
    source = image;
    useGameHud = true;
    setSourceRegions();
    setSourceLabel('스크린샷');
    message(draftRegions.coord ? '자동 영역을 적용했습니다. 인식을 시작하세요.' : '좌표와 나침반 영역을 지정한 뒤 인식하세요.');
  } catch (error) {
    if (input.files[0] === file) message('이미지를 열지 못했습니다: ' + error.message);
  }
};
$('mapFile').onchange = async event => {
  const [file] = event.target.files;
  if (!file) return;
  const request = ++mapImageRequest;
  loadingMap = true;
  updateSettingsButtons();
  try {
    const image = await loadImage(file);
    if (request === mapImageRequest) draftMap = {image, name: file.name};
  } catch (error) {
    if (request === mapImageRequest) message('지도 이미지를 열지 못했습니다: ' + error.message);
  } finally {
    if (request === mapImageRequest) {
      loadingMap = false;
      updateSettingsButtons();
    }
  }
};
function drawDemo(){fc.fillStyle='#192c39';fc.fillRect(0,0,960,540);fc.fillStyle='#274858';for(let y=140;y<520;y+=30){fc.beginPath();fc.moveTo(0,y);fc.lineTo(960,y-35);fc.strokeStyle='#355c68';fc.stroke();}fc.fillStyle='#f3f2e6';fc.fillRect(36,30,365,78);fc.fillStyle='#111';fc.font='bold 38px monospace';fc.fillText('12345, 3456',50,82);fc.fillStyle='#b9d5da';fc.font='16px sans-serif';fc.fillText('DEMO · 합성 화면 / 실제 게임 아님',36,500);fc.save();fc.translate(842,100);fc.fillStyle='#0a1621';fc.beginPath();fc.arc(0,0,68,0,Math.PI*2);fc.fill();fc.strokeStyle='#597987';fc.stroke();fc.fillStyle='#eee';fc.font='14px sans-serif';fc.fillText('N',-5,-49);fc.rotate(Math.PI/3);fc.fillStyle='#ee3838';fc.beginPath();fc.moveTo(0,-45);fc.lineTo(-7,6);fc.lineTo(7,6);fc.closePath();fc.fill();fc.fillStyle='#ddd';fc.beginPath();fc.moveTo(0,36);fc.lineTo(-7,6);fc.lineTo(7,6);fc.fill();fc.restore();}
$('demo').onclick=()=>{stopSource();drawDemo();setSize(960,540);source='demo';setSourceRegions();setSourceLabel('데모 · 합성 화면');message('인식 상태 탭에서 한 번 인식을 눌러 데모를 확인하세요.');};
function selectionCanvas() {
  return selecting === 'extraCompass' ? compassCapture : capture;
}

for (const [id, key] of [['coordRegion', 'coord'], ['compassRegion', 'compass']]) {
  $(id).onclick = () => {
    if (!source) {
      message('먼저 화면을 연결하세요.');
      return;
    }
    cancelSelection();
    selecting = key === 'compass' && compassStream ? 'extraCompass' : key;
    selectionCanvas().classList.add('selecting');
    if (selecting === 'extraCompass') compassCapture.scrollIntoView({block: 'nearest'});
    $('selectionHint').textContent = (key === 'coord' ? '좌표 숫자 두 개만'
      : '나침반 중심을 가운데에 두고 전체 나침반이 포함되도록') + ' 드래그해 지정하세요.';
  };
}

function point(event, canvas) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
  };
}

for (const canvas of [capture, compassCapture]) {
  canvas.onpointerdown = event => {
    if (!selecting || canvas !== selectionCanvas()) return;
    start = point(event, canvas);
    drag = null;
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (!start || canvas !== selectionCanvas()) return;
    const p = point(event, canvas);
    drag = {x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(start.x - p.x), h: Math.abs(start.y - p.y)};
  };
  canvas.onpointerup = () => {
    if (!start || canvas !== selectionCanvas()) return;
    if (drag?.w > 8 && drag?.h > 8) {
      draftRegions[selecting] = drag;
      refreshPreview();
      updateSettingsButtons();
      message('새 영역을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
    }
    cancelSelection();
  };
  canvas.onpointercancel = cancelSelection;
}
function captureImage() {
  if (source === 'video') return video.readyState >= 2 ? video : null;
  return source === 'demo' ? demoFrame : source;
}

function compassImage(image) {
  if (!compassStream) return image;
  return compassVideo.readyState >= 2 ? compassVideo : null;
}

function crop(image, region, canvas, readPixels = false) {
  const width = Math.max(1, Math.round(region.w));
  const height = Math.max(1, Math.round(region.h));
  const context = canvas.getContext('2d', {willReadFrequently: readPixels});
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, width, height);
  return context;
}

function readSailingCrop(image, x, y, width, height) {
  const context = crop(image, {x, y, w: width, h: height}, sailingCrop, true);
  return context.getImageData(0, 0, width, height);
}

function sampleSailingDay(image, time) {
  if (!useGameHud || capture.width < 43 || capture.height < 86) return null;
  if (sailingDayRegion) {
    const {x, y} = sailingDayRegion;
    const day = readSailingDay(readSailingCrop(image, x, y, 21, 11));
    if (day !== null) return day;
  }
  if (time - lastSailingSearch < sailingSearchIntervalMs) return null;
  lastSailingSearch = time;
  // Window sharing can include the title bar and window borders.
  const match = findSailingDay(readSailingCrop(image, 14, 19, 29, 67));
  if (!match) return null;
  sailingDayRegion = {x: 14 + match.x, y: 19 + match.y};
  return match.day;
}
function prepareCoordinates(input, surveyText, mode) {
  const processed = document.createElement('canvas');
  const scale = surveyText ? 6 : 3;
  processed.width = input.width * scale;
  processed.height = input.height * scale;
  const output = processed.getContext('2d');

  if (surveyText) {
    const context = input.getContext('2d');
    const pixels = context.getImageData(0, 0, input.width, input.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const whiteText = Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) >= 165;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = whiteText ? 0 : 255;
    }
    context.putImageData(pixels, 0, 0);
  }
  output.drawImage(input, 0, 0, processed.width, processed.height);

  if (mode === 'light' || mode === 'dark') {
    const pixels = output.getImageData(0, 0, processed.width, processed.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const bright = .299 * pixels.data[i] + .587 * pixels.data[i + 1] + .114 * pixels.data[i + 2] > 150;
      const value = bright === (mode === 'light') ? 0 : 255;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
    }
    output.putImageData(pixels, 0, 0);
  }
  return processed;
}
async function getWorker(){if(!workerPromise){workerPromise=createWorker('eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr',langPath:'/ocr',workerBlobURL:false}).then(async w=>{await w.setParameters({tessedit_char_whitelist:'0123456789, .',tessedit_pageseg_mode:PSM.SINGLE_LINE});return w;}).catch(e=>{workerPromise=null;throw e;});}return workerPromise;}
function captureRecognition(image, values, activeRegions, samples) {
  if (!hasRegions(activeRegions)) return null;
  const mode = values.preprocess;
  const key = JSON.stringify([activeRegions.coord, mode]);
  let sample = samples.get(key);
  if (!sample) {
    const input = document.createElement('canvas');
    const context = crop(image, activeRegions.coord, input, true);
    const surveyText = activeRegions.coord.gameHud && mode === 'auto';
    const glyphText = surveyText && readSurveyText(context.getImageData(0, 0, input.width, input.height));
    sample = {input, surveyText, glyphText, mode, ocr: null};
    samples.set(key, sample);
  }

  const region = activeRegions[compassStream ? 'extraCompass' : 'compass'];
  const bearingImage = compassImage(image);
  if (!region || !bearingImage) return {sample, values, angle: null};
  const compass = document.createElement('canvas');
  const compassContext = crop(bearingImage, region, compass, true);
  const pixels = compassContext.getImageData(0, 0, compass.width, compass.height);
  const offset = Number(values.offset);
  const bearing = region.gameHud
    ? gameCompassAngle(pixels, offset)
    : compassAngle(pixels, offset) ?? gameCompassAngle(pixels, offset);
  return {sample, values, angle: bearing?.angle ?? null};
}

async function readRecognition(captured) {
  const {sample, values, angle} = captured;
  const readPosition = text => parseCoordinates(text, Number(values.worldWidth), Number(values.worldHeight));
  const glyphPosition = sample.glyphText ? readPosition(sample.glyphText) : null;
  if (glyphPosition) return {position: glyphPosition, angle, raw: sample.glyphText + ' / 숫자 모양 일치'};

  try {
    sample.ocr ??= getWorker().then(worker => worker.recognize(prepareCoordinates(sample.input, sample.surveyText, sample.mode)));
    const {data} = await sample.ocr;
    const position = data.confidence >= Number(values.confidence) ? readPosition(data.text) : null;
    return {position, angle, raw: (data.text.trim() || '(없음)') + ' / OCR 신뢰도 ' + Math.round(data.confidence) + '%'};
  } catch (error) {
    return {position: null, angle, raw: '—', error: error.message};
  }
}

function showPreview(result, status) {
  const fix = result?.position;
  $('position').textContent = fix ? fix.x + ' / ' + fix.y : result ? '인식 실패' : '— / —';
  previewBearing = result?.angle ?? null;
  showPreviewBearing();
  $('raw').textContent = result?.raw ?? '—';
  $('state').textContent = status ?? (result?.error ? '오류' : fix && result.angle !== null ? '인식 완료' : result ? '확인 필요' : '대기');
}

function recognitionMessage(result) {
  if (result.error) return '인식 오류: ' + result.error;
  if (!result.position) return '좌표를 읽지 못했습니다. 게임에서 측량이 켜져 있는지와 좌표 영역을 확인하세요.';
  if (result.angle === null) return '좌표를 읽었지만 방향 표식을 찾지 못했습니다. 나침반 영역을 확인하세요.';
  return '좌표와 방향을 인식했습니다.';
}

async function recognize({live, preview, manual = false}) {
  const image = captureImage();
  if (!image || busy) return;
  const epoch = generation;
  const bearingVersion = compassVersion;
  const version = previewVersion;
  const values = savedValues;
  const fixTime = performance.now();
  busy = true;
  $('once').disabled = true;
  if (live) liveRequested = false;
  if (preview) previewRequested = false;
  try {
    const samples = new Map();
    const trackingFrame = live && running && source === 'video' && fixTime >= trackingSince;
    const sailingDay = trackingFrame ? sampleSailingDay(image, fixTime) : null;
    if (sailingDay !== null) {
      sailingClock = updateSailingClock(sailingClock, sailingDay, fixTime, sailingTimeoutMs);
      showSailingDay(sailingDay);
    }
    const liveCapture = live ? captureRecognition(image, values, savedRegions, samples) : null;
    const draftCapture = preview ? captureRecognition(image, draftValues, draftRegions, samples) : null;
    if (draftCapture || (liveCapture && !previewDiffers())) showPreview(null, '분석 중');

    if (liveCapture) {
      const result = await readRecognition(liveCapture);
      if (epoch !== generation) return;
      if (bearingVersion !== compassVersion) result.angle = null;
      savedResult = result;
      position = result.position;
      angle = result.angle;
      const worldWidth = Number(values.worldWidth);
      const stillTracking = trackingFrame && running && fixTime >= trackingSince;
      if (stillTracking) {
        recordRouteFix(position, sailingDay, fixTime);
        recordCoordinateAttempt(fixTime, worldWidth);
        routePlanner.updateNavigation(worldWidth === 16384 && Number(values.worldHeight) === 8192 ? position : null,
          averageMotion?.speed ?? null);
      }
      $('heading').textContent = formatBearing(angle, Number(savedValues.bearingStep));
      if (!previewDiffers()) showPreview(result);
      if (manual && !draftCapture) message(recognitionMessage(result));
    }

    if (draftCapture && version === previewVersion) {
      const result = await readRecognition(draftCapture);
      if (epoch !== generation || version !== previewVersion) return;
      showPreview(result);
      if (manual) message(recognitionMessage(result));
    }
  } catch (error) {
    if (epoch === generation && version === previewVersion) {
      showPreview(null, '오류');
      message('인식 오류: ' + error.message);
    }
  } finally {
    busy = false;
    $('once').disabled = false;
  }
}

$('once').onclick = () => {
  if (!source || !hasRegions(draftRegions)) {
    message('화면을 연결하고 좌표·나침반 영역을 모두 지정하세요.');
    return;
  }
  const preview = previewDiffers();
  recognize({live: !preview, preview, manual: true});
};
function setTracking(active) {
  running = active;
  lastTick = -Infinity;
  trackingSince = active ? performance.now() : Infinity;
  clearMotion();
  clearPrediction();
  $('track').textContent = active ? '연속 인식 중지' : '연속 인식 시작';
}

$('track').onclick = () => {
  if (!running && (!source || !hasRegions(savedRegions))) {
    message('연속 인식 전에 화면을 연결하고 두 인식 영역을 지정해 저장하세요.');
    return;
  }
  setTracking(!running);
};
function drawMap(time) {
  const defaultReady = defaultMapImage.complete && defaultMapImage.naturalWidth;
  const image = savedMap?.image ?? (defaultReady ? defaultMapImage : null);
  const {worldWidth, worldHeight, originX, originY, lineLength, lineLengthMode, lineDays, bearingStep,
    showDayArrows, adjustSailingTime} = savedValues;
  const requested = estimateRequested();
  updateEstimatedPosition(time, Number(worldWidth), Number(worldHeight), requested);
  const step = Number(bearingStep);
  const mapPosition = position ?? (requested ? estimatedPosition : lastMeasuredPosition);
  const mapCourse = estimatedPosition ? lastMeasuredCourse : averageMotion?.course ?? null;
  const speed = estimatedPosition ? predictionFix.speed : averageMotion?.speed ?? 0;
  const dayDistance = speed * secondsPerSailingDay;
  const directionLength = lineLengthMode === 'days' ? dayDistance * Number(lineDays) : Number(lineLength);
  const positionTime = estimatedPosition ? estimatedPositionTime : previousMotionFix?.time ?? time;
  const firstDayFraction = showDayArrows && adjustSailingTime && sailingDayIsCurrent(time)
    ? nextSailingDayFraction(sailingClock.boundary, positionTime, secondsPerSailingDay * 1000) : 1;
  mapView.draw(image, mapPosition, roundBearing(angle, step), roundBearing(mapCourse, step),
    Number(worldWidth), Number(worldHeight), Number(originX), Number(originY), directionLength, Boolean(estimatedPosition),
    showDayArrows ? dayDistance : 0, firstDayFraction, routePoints, Number(savedValues.routeDayInterval));
}
function drawCapturePreview(canvas, image, regions) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (image) context.drawImage(image, 0, 0);
  else {
    context.fillStyle = '#08121b';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  for (const [key, region] of Object.entries(regions)) {
    if (!region) continue;
    context.strokeStyle = key === 'compass' ? '#f8bc72' : '#80efd0';
    context.lineWidth = 3;
    context.strokeRect(region.x, region.y, region.w, region.h);
  }
  if (drag && canvas === selectionCanvas()) {
    context.strokeStyle = '#80efd0';
    context.strokeRect(drag.x, drag.y, drag.w, drag.h);
  }
}

function render(time) {
  if (source === 'video' && video.readyState >= 2
    && (capture.width !== video.videoWidth || capture.height !== video.videoHeight)) {
    const resume = running;
    setSize(video.videoWidth, video.videoHeight);
    resetCaptureRegions();
    setSourceRegions();
    if (resume) {
      setTracking(true);
    }
    message(draftRegions.coord ? '화면 크기에 맞춰 자동 영역을 다시 적용했습니다.' : '공유 화면 크기가 변경됐습니다. 인식 영역을 다시 지정하세요.');
  }
 if (compassStream && compassVideo.readyState >= 2
   && (compassCapture.width !== compassVideo.videoWidth || compassCapture.height !== compassVideo.videoHeight)) {
   applyExtraCompassRegion();
 }
 if (!settingsDialog.open || capturePanel.hidden) {
   lastPreviewTime = -Infinity;
 } else if (time - lastPreviewTime >= previewIntervalMs) {
   lastPreviewTime = time;
   const image = captureImage();
   const bearingImage = compassImage(image);
   const bearingRegion = draftRegions[compassStream ? 'extraCompass' : 'compass'];
   drawCapturePreview(capture, image, {coord: draftRegions.coord, compass: compassStream ? null : bearingRegion});
   if (compassStream) drawCapturePreview(compassCapture, bearingImage, {compass: bearingRegion});
   for (const [id, previewImage, region] of [['coordCrop', image, draftRegions.coord], ['compassCrop', bearingImage, bearingRegion]]) {
     const canvas = $(id);
     if (previewImage && region) crop(previewImage, region, canvas);
     else canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
   }
 }
 if (previousMotionFix && time - previousMotionFix.time > maxFixGap) clearMotion();
 if (sailingClock && !sailingDayIsCurrent(time)) showSailingDay();
 drawMap(time);
 if (captureImage() && !busy) {
   const tick = running && time - lastTick >= 1000 / Number(savedValues.recognitionFps);
   const live = (tick || liveRequested) && hasRegions(savedRegions);
   const preview = settingsDialog.open && previewDiffers() && hasRegions(draftRegions) && (previewRequested || tick);
   if (tick) lastTick = time;
   if (live || preview) recognize({live, preview});
 }
 requestAnimationFrame(render);
}
showSpeed();
setSize(960,540);requestAnimationFrame(render);
