import './style.css';
import {createWorker,PSM} from 'tesseract.js';
import {parseCoordinates,compassAngle,gameHudRegions,gameCompassAngle,readSurveyText,appendMotionSamples,measureAverageMotion,hasSailingDay,findSailingDay,estimatePosition,shouldEstimatePosition} from './vision.js';
import {createMapView} from './map.js';
const $=id=>document.getElementById(id), capture=$('capture'), ctx=capture.getContext('2d'), video=$('video');
const frame=document.createElement('canvas'), fc=frame.getContext('2d',{willReadFrequently:true});
const defaultMapImage = new Image();
defaultMapImage.src = `${import.meta.env.BASE_URL}worldmap_0.png`;
const mapView = createMapView($('map'), {
  zoomIn: $('mapZoomIn'),
  zoomOut: $('mapZoomOut'),
  reset: $('mapReset'),
  zoomLevel: $('mapZoomLevel'),
});
let source=null,stream=null,draftRegions={},selecting=null,start=null,drag=null,busy=false,running=false,workerPromise=null,position=null,angle=null,generation=0,lastTick=0;
let useGameHud = false;
const motionSamples = [];
let previousMotionFix = null;
let course = null;
let trackingSince = Infinity;
const maxFixGap = 6000;
const predictionWindowMs = 20_000;
const sailingTimeoutMs = 5000;
const knotsPerCoordinatePerSecond = 3.3014197;
let sailingDayRegion = null;
let lastSailingDay = -Infinity;
const coordinateAttempts = [];
let lastMeasuredPosition = null;
let lastMeasuredCourse = null;
let predictionFix = null;
let estimatedPosition = null;
let nextEstimate = 0;
function message(text) {
  $('message').textContent = text;
  $('screenMessage').textContent = text;
}
const defaultSelectionHint = $('selectionHint').textContent;
const autoRegionHint = '게임 화면 오른쪽 아래의 측량 좌표와 나침반 영역을 자동으로 사용합니다.';
const settingsDialog = $('settingsDialog');
const capturePanel = $('capturePanel');
const recognitionPanel = $('recognitionPanel');
const recognitionFps = $('recognitionFps');
const recognitionFpsSlider = $('recognitionFpsSlider');
const motionAverageSeconds = $('motionAverageSeconds');
const maxMotionWindowMs = Number(motionAverageSeconds.max) * 1000;
const settingsFields = [...recognitionPanel.querySelectorAll('.settings input:not(#recognitionFpsSlider), .settings select')];
const defaultValues = readSettings();
const settingsKey = 'dho-assist.settings.v1';
const recognitionKeys = ['preprocess', 'confidence', 'offset', 'worldWidth', 'worldHeight'];
let savedValues = restoreSettings();
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
const settingsTabs = [$('recognitionTab'), $('captureTab')];
for (const group of document.querySelectorAll('[data-share-controls]')) {
  group.append($('sharingControls').content.cloneNode(true));
}
const shareStarts = document.querySelectorAll('[data-share-start]');
const shareStops = document.querySelectorAll('[data-share-stop]');
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
  return Object.fromEntries(settingsFields.map(field => [field.id, field.value]));
}

function writeSettings(values) {
  for (const field of settingsFields) field.value = values[field.id];
  syncMeasurementControls();
}

function syncMeasurementControls() {
  if (recognitionFps.validity.valid) recognitionFpsSlider.value = recognitionFps.value;
  $('motionAverageValue').textContent = `${motionAverageSeconds.value}초`;
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

function sameRegions(left, right) {
  return JSON.stringify(left.coord) === JSON.stringify(right.coord)
    && JSON.stringify(left.compass) === JSON.stringify(right.compass);
}

function hasRegions(value) {
  return Boolean(value.coord && value.compass);
}

function previewDiffers() {
  return recognitionKeys.some(key => draftValues[key] !== savedValues[key]) || !sameRegions(draftRegions, savedRegions);
}

function updateSettingsButtons() {
  $('settingsChanges').hidden = !loadingMap && draftMap === savedMap
    && sameRegions(draftRegions, savedRegions) && settingsFields.every(field => field.value === savedValues[field.id]);
  $('saveSettings').disabled = loadingMap;
  $('mapFileName').textContent = draftMap?.name ?? '기본 지도';
}

function refreshPreview() {
  previewVersion++;
  previewRequested = previewDiffers() && hasRegions(draftRegions) && Boolean(source);
  showPreview(previewDiffers() ? null : savedResult);
}

function editSettings() {
  syncMeasurementControls();
  const previous = draftValues;
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
  if (!recognitionPanel.checkValidity()) {
    selectSettingsTab(settingsTabs[0]);
    recognitionPanel.reportValidity();
    return;
  }
  const changedRecognition = previewDiffers();
  const changedMotionWindow = savedValues.motionAverageSeconds !== draftValues.motionAverageSeconds;
  savedValues = draftValues;
  savedRegions = {...draftRegions};
  savedMap = draftMap;
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
  showMapBearings();
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
  for (const status of shareStatuses) status.textContent = text;

  if (sharing && overview.contains(focused)) $('track').focus();
  if (!sharing && focused?.matches('[data-share-stop]')) {
    const startButton = focused.parentElement.querySelector('[data-share-start]');
    (startButton.disabled ? $('captureTab') : startButton).focus();
  }
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
    case 'ArrowLeft':
    case 'ArrowRight': next = settingsTabs[1 - index]; break;
    case 'Home': next = settingsTabs[0]; break;
    case 'End': next = settingsTabs[1]; break;
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
settingsDialog.onclose = () => {
  if (selecting) cancelSelection();
};

function showMotion(motion = null) {
  course = motion?.course ?? null;
  if (course !== null) lastMeasuredCourse = course;
  $('speed').textContent = motion ? motion.speed.toFixed(1) : '—';
  showCourseBearing();
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
  const displayCourse = estimatedPosition ? lastMeasuredCourse : course;
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
  lastSailingDay = -Infinity;
  predictionFix = null;
  estimatedPosition = null;
  $('estimatedLocation').hidden = true;
  showCourseBearing();
}

function readSailingDay() {
  if (!sailingDayRegion) return false;
  const {x, y} = sailingDayRegion;
  return hasSailingDay(fc.getImageData(x, y, 21, 11));
}

function rememberPredictionFix(time, worldWidth) {
  const speed = measureAverageMotion(motionSamples, predictionWindowMs, worldWidth)?.speed ?? 0;
  const knots = speed * knotsPerCoordinatePerSecond;
  predictionFix = angle !== null && knots >= 1 && knots < 100 ? {position, angle, speed, time} : null;
}

function updateEstimatedPosition(time, worldWidth, worldHeight, estimateRequested) {
  if (time - lastSailingDay > sailingTimeoutMs) {
    predictionFix = null;
  }
  const wasEstimated = Boolean(estimatedPosition);
  if (!predictionFix || !estimateRequested || time < predictionFix.time) {
    estimatedPosition = null;
  } else if (!estimatedPosition || time >= nextEstimate) {
    estimatedPosition = estimatePosition(predictionFix, (time - predictionFix.time) / 1000, worldWidth, worldHeight);
    nextEstimate = time + 200;
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
    if (time - lastSailingDay <= sailingTimeoutMs) rememberPredictionFix(time, worldWidth);
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
  $('selectionHint').textContent = draftRegions.coord?.gameHud && draftRegions.compass?.gameHud
    ? autoRegionHint : defaultSelectionHint;
}

function resetCaptureRegions() {
  running = false;
  trackingSince = Infinity;
  $('track').textContent = '연속 인식 시작';
  draftRegions = {};
  savedRegions = {};
  cancelSelection();
  for (const id of ['coordCrop', 'compassCrop']) {
    const canvas = $(id);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  resetRecognition();
  updateSettingsButtons();
}

function stopSource() {
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
function setSize(w,h){frame.width=capture.width=w;frame.height=capture.height=h;}
function defaultRegions() {
  if (source === 'demo') return {...demoRegions};
  if (!useGameHud) return {};
  const insets = source === 'video' ? firefoxWindowInsets : undefined;
  return gameHudRegions(frame.width, frame.height, insets);
}

function setSourceRegions() {
  draftRegions = defaultRegions();
  savedRegions = {...draftRegions};
  $('autoRegions').disabled = !useGameHud || !hasRegions(draftRegions);
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
  writeSettings(defaultValues);
  editSettings();
  message('인식 보정과 지도 기본값을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
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
  for (const button of shareStarts) button.disabled = true;
  let next;
  try {
    next = await navigator.mediaDevices.getDisplayMedia({video: {displaySurface: 'window'}, audio: false});
    if (request.cancelled) {
      next.getTracks().forEach(track => track.stop());
      return;
    }
    stopSource();
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
    for (const button of shareStarts) button.disabled = false;
  }
}

for (const button of shareStarts) button.onclick = startSharing;
for (const button of shareStops) {
  button.onclick = () => {
    if (pendingShare) pendingShare.cancelled = true;
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
$('demo').onclick=()=>{stopSource();setSize(960,540);source='demo';setSourceRegions();setSourceLabel('데모 · 합성 화면');message('인식 상태 탭에서 한 번 인식을 눌러 데모를 확인하세요.');};
for(const [id,key] of [['coordRegion','coord'],['compassRegion','compass']])$(id).onclick=()=>{if(!source){message('먼저 화면을 연결하세요.');return;}selecting=key;capture.classList.add('selecting');$('selectionHint').textContent=(key==='coord'?'좌표 숫자 두 개만':'나침반 중심을 가운데에 두고 전체 바늘이 포함되도록')+' 드래그해 지정하세요.';};
function point(e){const r=capture.getBoundingClientRect();return {x:Math.max(0,Math.min(capture.width,(e.clientX-r.left)*capture.width/r.width)),y:Math.max(0,Math.min(capture.height,(e.clientY-r.top)*capture.height/r.height))};}
capture.onpointerdown=e=>{if(!selecting)return;start=point(e);drag=null;capture.setPointerCapture(e.pointerId);};
capture.onpointermove=e=>{if(start){const p=point(e);drag={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(start.x-p.x),h:Math.abs(start.y-p.y)};}};
capture.onpointerup = () => {
  if (drag?.w > 8 && drag?.h > 8) {
    draftRegions[selecting] = drag;
    refreshPreview();
    updateSettingsButtons();
    message('새 영역을 미리봅니다. 변경사항 저장을 눌러 적용하세요.');
  }
  cancelSelection();
};
capture.onpointercancel = cancelSelection;
function crop(region,canvas){canvas.width=Math.max(1,Math.round(region.w));canvas.height=Math.max(1,Math.round(region.h));canvas.getContext('2d').drawImage(frame,region.x,region.y,region.w,region.h,0,0,canvas.width,canvas.height);}
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
function captureRecognition(values, activeRegions, samples) {
  if (!hasRegions(activeRegions)) return null;
  const mode = values.preprocess;
  const key = JSON.stringify([activeRegions.coord, mode]);
  let sample = samples.get(key);
  if (!sample) {
    const input = document.createElement('canvas');
    crop(activeRegions.coord, input);
    const surveyText = activeRegions.coord.gameHud && mode === 'auto';
    const glyphText = surveyText && readSurveyText(input.getContext('2d').getImageData(0, 0, input.width, input.height));
    sample = {input, surveyText, glyphText, mode, ocr: null};
    samples.set(key, sample);
  }

  const compass = document.createElement('canvas');
  crop(activeRegions.compass, compass);
  const pixels = compass.getContext('2d').getImageData(0, 0, compass.width, compass.height);
  const offset = Number(values.offset);
  const bearing = activeRegions.compass.gameHud
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
    return {position: null, angle: null, raw: '—', error: error.message};
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
  if (!source || busy) return;
  const epoch = generation;
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
    const sailingDayVisible = trackingFrame && readSailingDay();
    // The shared window can include the title bar and visible borders.
    const sailingSearch = trackingFrame && !sailingDayRegion && useGameHud && frame.width >= 43 && frame.height >= 86
      ? fc.getImageData(14, 19, 29, 67) : null;
    const liveCapture = live ? captureRecognition(values, savedRegions, samples) : null;
    const draftCapture = preview ? captureRecognition(draftValues, draftRegions, samples) : null;
    if (draftCapture || (liveCapture && !previewDiffers())) showPreview(null, '분석 중');

    if (liveCapture) {
      const result = await readRecognition(liveCapture);
      if (epoch !== generation) return;
      savedResult = result;
      position = result.position;
      angle = result.angle;
      const worldWidth = Number(values.worldWidth);
      const stillTracking = trackingFrame && running && fixTime >= trackingSince;
      if (stillTracking) {
        if (sailingDayVisible) lastSailingDay = fixTime;
        if (position && sailingSearch && !sailingDayRegion) {
          const match = findSailingDay(sailingSearch);
          if (match) {
            sailingDayRegion = {x: 14 + match.x, y: 19 + match.y};
            lastSailingDay = fixTime;
          }
        }
        recordCoordinateAttempt(fixTime, worldWidth);
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
  const {worldWidth, worldHeight, originX, originY, lineLength, bearingStep} = savedValues;
  const requested = estimateRequested();
  updateEstimatedPosition(time, Number(worldWidth), Number(worldHeight), requested);
  const step = Number(bearingStep);
  const mapPosition = position ?? (requested ? estimatedPosition : lastMeasuredPosition);
  const mapCourse = estimatedPosition ? lastMeasuredCourse : course;
  mapView.draw(image, mapPosition, roundBearing(angle, step), roundBearing(mapCourse, step),
    Number(worldWidth), Number(worldHeight), Number(originX), Number(originY), Number(lineLength), Boolean(estimatedPosition));
}
function render(time){if(source==='demo')drawDemo();else if(source==='video'&&video.readyState>=2){
  if (frame.width !== video.videoWidth || frame.height !== video.videoHeight) {
    const resume = running;
    setSize(video.videoWidth, video.videoHeight);
    resetCaptureRegions();
    setSourceRegions();
    if (resume) {
      setTracking(true);
    }
    message(draftRegions.coord ? '화면 크기에 맞춰 자동 영역을 다시 적용했습니다.' : '공유 화면 크기가 변경됐습니다. 인식 영역을 다시 지정하세요.');
  }
  fc.drawImage(video,0,0);
}else if(source instanceof Image)fc.drawImage(source,0,0);else{fc.fillStyle='#08121b';fc.fillRect(0,0,frame.width,frame.height);}
 if (settingsDialog.open && !capturePanel.hidden) {
   ctx.drawImage(frame, 0, 0, capture.width, capture.height);
   for (const [key, region] of Object.entries({...draftRegions, ...(drag ? {drag} : {})})) {
     ctx.strokeStyle = key === 'compass' ? '#f8bc72' : '#80efd0';
     ctx.lineWidth = 3;
     ctx.strokeRect(region.x, region.y, region.w, region.h);
   }
   for (const [key, id] of [['coord', 'coordCrop'], ['compass', 'compassCrop']]) {
     const canvas = $(id);
     if (draftRegions[key]) crop(draftRegions[key], canvas);
     else canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
   }
 }
 if (previousMotionFix && time - previousMotionFix.time > maxFixGap) clearMotion();
 drawMap(time);
 if (source && !busy) {
   const tick = running && time - lastTick >= 1000 / Number(savedValues.recognitionFps);
   const live = (tick || liveRequested) && hasRegions(savedRegions);
   const preview = settingsDialog.open && previewDiffers() && hasRegions(draftRegions) && (previewRequested || tick);
   if (tick) lastTick = time;
   if (live || preview) recognize({live, preview});
 }
 requestAnimationFrame(render);
}
setSize(960,540);requestAnimationFrame(render);
