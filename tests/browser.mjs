import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

async function expectReset(page) {
  assert.equal(await page.locator('#position').textContent(), '— / —');
  assert.equal(await page.locator('#heading').textContent(), '—°');
  assert.equal(await page.locator('#sailingDay').textContent(), '—');
  assert.equal(await page.locator('#course').textContent(), '—°');
  assert.equal(await page.locator('#speed').textContent(), '—');
  assert.equal(await page.locator('#raw').textContent(), '—');
  assert.equal(await page.locator('#state').textContent(), '대기');
  assert.equal(await page.locator('#track').textContent(), '연속 인식 시작');
  assert.equal(await page.locator('#capture.selecting').count(), 0);
  for (const id of ['coordCrop', 'compassCrop']) {
    const blank = await page.locator(`#${id}`).evaluate(canvas => {
      const {data} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return data.every(value => value === 0);
    });
    assert.ok(blank, `${id} still shows a previous frame`);
  }
}

async function selectRegion(page, buttonId, x, y, width, height) {
  await page.locator(`#${buttonId}`).click();
  const box = await page.locator('#capture').boundingBox();
  const left = box.x + x * box.width / 960;
  const top = box.y + y * box.height / 540;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + width * box.width / 960, top + height * box.height / 540);
  await page.mouse.up();
}

async function verifyMapControls(page) {
  await page.setViewportSize({width: 1760, height: 1100});
  const fixedCanvas = await page.addStyleTag({content: '#map { width: 1202px; height: 602px; }'});
  await page.waitForFunction(() => {
    const {width, height} = document.getElementById('map');
    return width === 1200 && height === 600;
  });
  await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 600;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ad3344';
    context.fillRect(0, 0, 300, 600);
    context.fillStyle = '#277143';
    context.fillRect(300, 0, 600, 600);
    context.fillStyle = '#2450a9';
    context.fillRect(900, 0, 300, 600);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#mapFile').setInputFiles({
    name: 'test-map.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  });
  await page.waitForFunction(() => document.getElementById('mapFileName').textContent === 'test-map.png');
  const unsavedPixel = await page.locator('#map').evaluate(canvas => canvas.getContext('2d').getImageData(30, 300, 1, 1).data.join(','));
  assert.notEqual(unsavedPixel, '173,51,68,255');
  await page.locator('#saveSettings').click();
  await page.locator('#closeSettings').click();
  const expectPixel = (x, y, color) => page.waitForFunction(({x, y, color}) => {
    const context = document.getElementById('map').getContext('2d');
    return context.getImageData(x, y, 1, 1).data.join(',') === color;
  }, {x, y, color});
  const red = '173,51,68,255';
  const green = '39,113,67,255';
  const blue = '36,80,169,255';
  await expectPixel(30, 300, red);

  const map = page.locator('#map');
  await map.press('ArrowLeft');
  await expectPixel(30, 300, blue);
  await expectPixel(90, 300, red);
  for (let i = 0; i < 40; i++) await map.press('ArrowLeft');
  await expectPixel(30, 300, blue);
  await page.locator('#mapReset').click();
  await expectPixel(30, 300, red);

  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  await page.mouse.move(box.x + box.width * 350 / 1200, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expectPixel(290, 300, green);
  assert.equal(await page.locator('#mapZoomLevel').inputValue(), '125');
  await page.locator('#mapZoomOut').click();
  await expectPixel(290, 300, red);
  await page.locator('#mapZoomOut').click();
  assert.equal(await page.locator('#mapZoomLevel').inputValue(), '80');
  await page.locator('#mapReset').click();

  await map.scrollIntoViewIfNeeded();
  const dragBox = await map.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * .6, dragBox.y + dragBox.height / 2);
  await page.mouse.up();
  await expectPixel(30, 300, blue);
  await page.locator('#mapReset').click();

  await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
  await page.locator('#originX').fill('-3955');
  await page.locator('#saveSettings').click();
  await page.locator('#closeSettings').click();
  await expectPixel(1194, 253, '128,239,208,255');
  await page.waitForFunction(() => {
    const context = document.getElementById('map').getContext('2d');
    const {data} = context.getImageData(16, 220, 32, 26);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 120 && data[i + 1] > 220 && data[i + 2] > 195) return true;
    }
    return false;
  });
  await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
  await page.locator('#originX').fill('0');
  await page.locator('#saveSettings').click();
  await page.locator('#closeSettings').click();
  await fixedCanvas.evaluate(style => style.remove());

  await page.locator('#toggleMapSidebar').click();
  for (const viewport of [{width: 420, height: 850}, {width: 1440, height: 1100}]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(({height}) => {
      const map = document.getElementById('map');
      const bounds = map.getBoundingClientRect();
      return map.width === map.clientWidth && map.height === map.clientHeight
        && bounds.bottom >= height - 30 && bounds.bottom <= height;
    }, viewport);
    const bounds = await map.boundingBox();
    if (viewport.width < viewport.height) assert.ok(bounds.height > bounds.width);
    const width = Math.round(bounds.width) - 2;
    const height = Math.round(bounds.height) - 2;
    await expectPixel(Math.floor(width / 2), 2, green);
    await expectPixel(Math.floor(width / 2), height - 3, green);
  }
  await page.locator('#toggleMapSidebar').click();
  await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
  await page.locator('#resetSettings').click();
  assert.equal(await page.locator('#mapFile').inputValue(), '');
  await page.locator('#saveSettings').click();
  await page.waitForFunction(color => {
    const map = document.getElementById('map');
    const context = map.getContext('2d');
    return context.getImageData(Math.floor(map.width / 2), 2, 1, 1).data.join(',') !== color;
  }, green);
}

const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.TEST_URL||'http://localhost:5173');
 assert.equal(await page.locator('#mapSidebarBody').isVisible(), false);
 await page.locator('#toggleMapSidebar').click();
 const mapShare = page.locator('#mapShare');
 const mapCompassShare = page.locator('#mapShare + #mapCompassShare');
 assert.equal(await mapShare.textContent(), '게임 화면 공유');
 assert.equal(await mapCompassShare.isHidden(), true);
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 assert.equal(await page.locator('#settingsDialog').evaluate(panel => panel.open), true);
 const settings = page.locator('#settingsDialog');
 await page.locator('#recognitionTab').click();
 const shareStart = settings.getByRole('button', {name:'게임 화면 공유', exact:true});
 const shareChange = settings.getByRole('button', {name:'게임 화면 변경', exact:true});
 const shareStop = settings.getByRole('button', {name:'공유 종료', exact:true});
 const resetSettings = page.getByRole('button', {name:'설정 초기화', exact:true});
 const saveSettings = page.getByRole('button', {name:'변경사항 저장', exact:true});
 const cancelSettings = page.getByRole('button', {name:'변경사항 취소', exact:true});
 assert.equal(await page.locator('#recognitionTab').getAttribute('aria-selected'), 'true');
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 공유']);
 assert.equal(await page.getByRole('combobox', {name:'공유 대상 선택'}).count(), 0);
 assert.equal(await page.locator('#capture').isVisible(), false);
 const generalTab = page.locator('#generalTab');
 const speedUnit = page.locator('#speedUnit');
 const speedUnitLabel = page.locator('#speedUnitLabel');
 assert.deepEqual(await speedUnit.locator('option').allTextContents(), ['분당 좌표', 'knot']);
 assert.equal(await speedUnitLabel.textContent(), '좌표/분');
 const lineLengthMode = page.locator('#lineLengthMode');
 const lineDays = page.locator('#lineDays');
 const lineLength = page.locator('#lineLength');
 const showDayArrows = page.locator('#showDayArrows');
 const adjustSailingTime = page.locator('#adjustSailingTime');
 const routeDayInterval = page.locator('#routeDayInterval');
 await generalTab.click();
 assert.equal(await generalTab.getAttribute('aria-selected'), 'true');
 assert.equal(await lineLengthMode.inputValue(), 'fixed');
 assert.equal(await lineLength.isVisible(), true);
 assert.equal(await lineLength.inputValue(), '16384');
 assert.equal(await lineDays.isVisible(), false);
 assert.equal(await showDayArrows.isChecked(), true);
 assert.equal(await adjustSailingTime.isChecked(), false);
 assert.equal(await routeDayInterval.inputValue(), '5');
 await page.locator('#captureTab').click();
 assert.equal(await page.locator('#captureTab').getAttribute('aria-selected'), 'true');
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 공유']);
 await page.getByRole('button',{name:'데모 화면',exact:true}).click();await page.waitForTimeout(200);
 await page.locator('#recognitionTab').click();
 await page.getByRole('button',{name:'한 번 인식',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('state').textContent==='인식 완료',{},{timeout:90000});
 assert.equal(await page.locator('#position').textContent(),'12345 / 3456');
 const angle=parseFloat(await page.locator('#heading').textContent());assert.ok(Math.abs(angle-60)<3,`heading ${angle}`);
 assert.equal(await saveSettings.isVisible(), false);
 await page.locator('#worldWidth').fill('10000');
 await page.waitForFunction(() => document.getElementById('position').textContent === '인식 실패');
 assert.equal(parseFloat(await page.locator('#heading').textContent()), angle);
 assert.equal(await saveSettings.isVisible(), true);
 await cancelSettings.click();
 assert.equal(await page.locator('#worldWidth').inputValue(), '16384');
 assert.equal(await page.locator('#position').textContent(), '12345 / 3456');
 await page.locator('#offset').fill('20');
 await page.waitForFunction(() => parseFloat(document.getElementById('previewHeading').textContent) > 75);
 assert.equal(parseFloat(await page.locator('#heading').textContent()), angle);
 await saveSettings.click();
 await page.waitForFunction(() => parseFloat(document.getElementById('heading').textContent) > 75);
 await resetSettings.click();
 assert.equal(await page.locator('#offset').inputValue(), '0');
 await saveSettings.click();
 await page.waitForFunction(() => Math.abs(parseFloat(document.getElementById('heading').textContent) - 60) < 3);
 await page.getByRole('button',{name:'연속 인식 시작'}).click();await page.waitForTimeout(1800);await page.getByRole('button',{name:'연속 인식 중지'}).click();
 await page.locator('#closeSettings').click();
 assert.equal(await page.locator('#settingsDialog').evaluate(panel => panel.open), false);
 assert.equal(await page.locator('#heading').isVisible(), true);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/demo.png',fullPage:true});
 await verifyMapControls(page);

 await page.locator('#captureTab').click();
 await page.locator('#coordRegion').click();
 await page.locator('#recognitionTab').click();
 assert.equal(await page.locator('#capture.selecting').count(), 0);
 assert.equal(await shareStop.count(), 0);

 // Draw a fixed-size HUD against two different client sizes without the desktop picker.
 await page.evaluate(() => {
   const canvas = document.createElement('canvas');
   const context = canvas.getContext('2d');
   function drawHud(width, height, coordinates, sailingDay = null, dayOffset = 0) {
     canvas.width = width;
     canvas.height = height;
     context.fillStyle = '#284254';
     context.fillRect(0, 0, width, height);
     context.font = '13px Arial';
     context.textAlign = 'right';
     context.fillStyle = '#fff';
     context.fillText(coordinates, width - 13, height - 264, 56);
     if (sailingDay !== null) {
       const glyph = {
         1: '100001111111000000', 2: '110011001011110011', 5: '101011101001000110',
       }[sailingDay];
       for (let i = 0; i < glyph.length; i++) {
         if (glyph[i] === '1') context.fillRect(23 + dayOffset + Math.floor(i / 6) * 2, 47 + (i % 6) * 2, 1, 1);
       }
     }

     const compassX = width - 148 + 56;
     const compassY = height - 108 + 39;
     context.beginPath();
     context.ellipse(compassX, compassY + 11, 54, 49, 0, 0, 2 * Math.PI);
     context.fillStyle = '#526b50';
     context.fill();
     context.fillStyle = '#ffff53';
     context.fillRect(compassX + 37, compassY - 20, 7, 7);
   }

   drawHud(960, 540, '', 1);
   const stream = canvas.captureStream();
   const [track] = stream.getVideoTracks();
   track.getSettings = () => ({displaySurface: 'window'});
   window.shareRequests = [];
   navigator.mediaDevices.getDisplayMedia = async options => {
     window.shareRequests.push(options);
     if (window.shareRequests.length !== 2) throw new DOMException('Test picker cancelled', 'NotAllowedError');
     return stream;
   };
   window.moveTestCapture = () => drawHud(960, 540, '4321, 6543');
   window.shiftSailingDay = () => drawHud(960, 540, '', 2, 4);
   window.showInitialFix = () => drawHud(960, 540, '1234, 3456');
   window.showSailingFix = () => drawHud(960, 540, '4361, 6543', 1);
   window.hideSurvey = (day = 1) => drawHud(960, 540, '', day);
   window.hideSailingDay = () => drawHud(960, 540, '');
   window.showRouteFix = (coordinates, day) => drawHud(960, 540, coordinates, day);
   window.resizeTestCapture = () => drawHud(800, 450, '4321, 6543');
 });

 await shareStart.click();
 await page.waitForFunction(() => document.getElementById('message').textContent.includes('Test picker cancelled'));
 await page.locator('#closeSettings').click();
 await mapShare.click();
 await page.waitForFunction(() => document.getElementById('sailingDay').textContent === '1일'
   && document.getElementById('position').textContent === '인식 실패');
 await page.evaluate(() => window.shiftSailingDay());
 await page.waitForFunction(() => document.getElementById('sailingDay').textContent === '2일'
   && document.getElementById('position').textContent === '인식 실패');
 await page.evaluate(() => window.showInitialFix());
 await page.waitForFunction(() => document.getElementById('position').textContent === '1234 / 3456');
 assert.equal(await mapShare.textContent(), '게임 화면 변경');
 assert.equal(await mapCompassShare.textContent(), '나침반 화면 추가');
 assert.equal(await mapCompassShare.isVisible(), true);
 assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
 await mapShare.click();
 await page.waitForFunction(() => document.getElementById('mapShareMessage').textContent.includes('Test picker cancelled'));
 assert.equal(await mapShare.textContent(), '게임 화면 변경');
 assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await page.locator('#captureTab').click();
 assert.equal(await resetSettings.isVisible(), true);
 await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-share-status]')).every(status => status.textContent === '게임 화면 공유 중'));
 assert.deepEqual(await page.evaluate(() => window.shareRequests), [
   {video: {displaySurface: 'window'}, audio: false},
   {video: {displaySurface: 'window'}, audio: false},
   {video: {displaySurface: 'window'}, audio: false},
 ]);
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 변경', '나침반 화면 추가', '공유 종료']);
 await shareChange.click();
 await page.waitForFunction(() => document.getElementById('screenMessage').textContent.includes('Test picker cancelled'));
 assert.equal(await shareChange.isVisible(), true);
 assert.equal(await shareStop.isVisible(), true);
 await page.locator('#recognitionTab').click();
 assert.equal(await page.getByRole('group', {name: '화면 연결'}).count(), 0);
 assert.match(await page.locator('#selectionHint').textContent(), /자동으로 사용합니다/);
 await page.waitForFunction(() => document.getElementById('state').textContent === '인식 완료');
 assert.equal(await page.locator('#position').textContent(), '1234 / 3456');
 assert.match(await page.locator('#raw').textContent(), /OCR 신뢰도/);
 const gameAngle = parseFloat(await page.locator('#heading').textContent());
 assert.ok(Math.abs(gameAngle - 296) < 4, `game heading ${gameAngle}`);
 await page.locator('#closeSettings').click();
 await mapCompassShare.click();
 await page.waitForFunction(() => document.getElementById('mapShareMessage').textContent.includes('Test picker cancelled'));
 assert.equal(await mapCompassShare.textContent(), '나침반 화면 추가');
 await page.evaluate(() => {
   const original = navigator.mediaDevices.getDisplayMedia;
   const canvas = document.createElement('canvas');
   canvas.width = 800;
   canvas.height = 450;
   const context = canvas.getContext('2d');
   context.fillStyle = '#284254';
   context.fillRect(0, 0, 800, 450);
   context.fillStyle = '#526b50';
   context.beginPath();
   context.ellipse(708, 392, 54, 49, 0, 0, 2 * Math.PI);
   context.fill();
   context.fillStyle = '#ffff53';
   context.fillRect(665, 369, 7, 7);
   const stream = canvas.captureStream();
   const [track] = stream.getVideoTracks();
   track.getSettings = () => ({displaySurface: 'window'});
   navigator.mediaDevices.getDisplayMedia = async () => stream;
   window.extraTrack = track;
   window.restoreSharePicker = () => { navigator.mediaDevices.getDisplayMedia = original; };
 });
 await mapCompassShare.click();
 await page.waitForFunction(() => document.getElementById('mapCompassShare').textContent === '나침반 화면 공유 취소');
 await page.waitForFunction(() => {
   const bearing = parseFloat(document.getElementById('heading').textContent);
   return bearing > 45 && bearing < 90 && document.getElementById('position').textContent === '1234 / 3456';
 });
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await page.locator('#captureTab').click();
 await page.waitForFunction(() => document.getElementById('compassCapture').width === 800);
 assert.equal(await page.locator('#compassCapture').isVisible(), true);
 await page.locator('#compassRegion').click();
 assert.equal(await page.locator('#compassCapture.selecting').count(), 1);
 assert.equal(await page.locator('#capture.selecting').count(), 0);
 await page.locator('#closeSettings').click();
 await mapCompassShare.click();
 await page.waitForFunction(bearing => parseFloat(document.getElementById('heading').textContent) === bearing, gameAngle);
 assert.equal(await page.locator('#position').textContent(), '1234 / 3456');
 assert.equal(await page.evaluate(() => window.extraTrack.readyState), 'ended');
 assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
 await page.evaluate(() => window.restoreSharePicker());
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await page.locator('#track').click();
 assert.equal(await page.locator('#track').textContent(), '연속 인식 시작');

 await page.locator('#captureTab').click();
 await selectRegion(page, 'coordRegion', 36, 30, 365, 78);
 assert.doesNotMatch(await page.locator('#selectionHint').textContent(), /자동으로 사용합니다/);
 await page.waitForFunction(() => document.getElementById('coordCrop').width > 300
   && document.getElementById('position').textContent === '인식 실패');
 assert.equal(parseFloat(await page.locator('#heading').textContent()), gameAngle);
 await cancelSettings.click();
 await page.waitForFunction(() => document.getElementById('coordCrop').width === 64);
 assert.equal(await page.locator('#position').textContent(), '1234 / 3456');
 assert.equal(await saveSettings.isVisible(), false);
 await selectRegion(page, 'coordRegion', 36, 30, 365, 78);
 await page.locator('#recognitionTab').click();
 await page.locator('#offset').fill('25');
 await page.locator('#worldWidth').fill('16000');
 await page.locator('#preprocess').selectOption('dark');
 await resetSettings.click();
 assert.equal(await page.locator('#offset').inputValue(), '0');
 assert.equal(await page.locator('#worldWidth').inputValue(), '16384');
 assert.equal(await page.locator('#preprocess').inputValue(), 'auto');
 await page.locator('#offset').fill('25');
 await page.locator('#captureTab').click();
 assert.doesNotMatch(await page.locator('#selectionHint').textContent(), /자동으로 사용합니다/);
 await resetSettings.click();
 assert.match(await page.locator('#selectionHint').textContent(), /자동으로 사용합니다/);
 assert.deepEqual(await page.locator('[data-share-status]').allTextContents(), ['게임 화면 공유 중', '게임 화면 공유 중']);
 await page.locator('#recognitionTab').click();
 assert.equal(await page.locator('#offset').inputValue(), '25');
 await page.locator('#offset').fill('0');
 await page.locator('#track').click();
 assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
 await page.waitForFunction(() => document.getElementById('state').textContent === '인식 완료');
 await page.locator('#closeSettings').click();
 await page.waitForFunction(() => document.getElementById('speed').textContent === '0.0');
 assert.equal(await page.locator('#course').textContent(), '—°');
 await page.evaluate(() => window.moveTestCapture());
 await page.waitForFunction(() => document.getElementById('course').textContent === '136°');
 assert.ok(parseFloat(await page.locator('#speed').textContent()) > 0);
 assert.ok(Math.abs(parseFloat(await page.locator('#heading').textContent()) - gameAngle) < 3);
 const movingSpeed = parseFloat(await page.locator('#speed').textContent());
 await page.waitForFunction(speed => {
   const average = parseFloat(document.getElementById('speed').textContent);
   return average > 0 && average < speed;
 }, movingSpeed);
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 const averageSlider = page.locator('#motionAverageSeconds');
 await averageSlider.press('Home');
 assert.equal(await page.locator('#motionAverageValue').textContent(), '1초');
 assert.equal(await page.locator('#course').textContent(), '136°');
 await saveSettings.click();
 await page.waitForFunction(() => document.getElementById('speed').textContent === '0.0'
   && document.getElementById('course').textContent === '—°');
 await averageSlider.fill('20');
 await saveSettings.click();
 assert.equal(await page.locator('#course').textContent(), '136°');
 await generalTab.click();
 await speedUnit.selectOption('knot');
 assert.equal(await speedUnitLabel.textContent(), '좌표/분');
 const speedConversion = await page.evaluate(() => {
   const speed = document.getElementById('speed');
   const coordinatesPerMinute = Number(speed.textContent);
   document.getElementById('saveSettings').click();
   return {coordinatesPerMinute, knots: Number(speed.textContent)};
 });
 assert.ok(speedConversion.coordinatesPerMinute > 0);
 assert.ok(Math.abs(speedConversion.knots - speedConversion.coordinatesPerMinute / 60 * 3.30181548) < 0.06);
 assert.equal(await speedUnitLabel.textContent(), 'knot');
 assert.equal(await page.locator('#course').textContent(), '136°');
 await page.locator('#recognitionTab').click();
 await page.locator('#bearingStep').selectOption({label: '1도 단위 (실험중)'});
 assert.match(await page.locator('#previewHeading').textContent(), /^\d+°$/);
 assert.equal(await page.locator('#course').textContent(), '136°');
 await saveSettings.click();
 assert.equal(await page.locator('#course').textContent(), '135°');
 await page.locator('#bearingStep').selectOption({label: '0.1도 단위 (실험중)'});
 await saveSettings.click();
 assert.equal(await page.locator('#course').textContent(), '135.0°');
 await page.locator('#closeSettings').click();
 await page.waitForFunction(() => document.getElementById('course').textContent === '—°'
   && document.getElementById('speed').textContent === '0.0', null, {timeout: 35000});

 await page.evaluate(() => window.showSailingFix());
 await page.waitForFunction(() => document.getElementById('position').textContent === '4361 / 6543');
 await page.waitForFunction(() => document.getElementById('course').textContent === '90.0°');
 await page.evaluate(() => {
   const context = document.getElementById('map').getContext('2d');
   const moveTo = context.moveTo;
   const lineTo = context.lineTo;
   const stroke = context.stroke;
   const arc = context.arc;
   const fillText = context.fillText;
   let start;
   let length;
   let vertices = [];
   const beginPath = context.beginPath;
   context.beginPath = function () {
     vertices = [];
     return beginPath.call(this);
   };
   const prototype = CanvasRenderingContext2D.prototype;
   window.routeDraw = {labels: [], radii: [], segments: []};
   const fillRect = prototype.fillRect;
   prototype.fillRect = function (...args) {
     if (this.fillStyle === '#091c27') window.routeDraw.segments = [];
     return fillRect.apply(this, args);
   };
   const drawImage = context.drawImage;
   context.drawImage = function (...args) {
     window.routeDraw.labels = [];
     window.routeDraw.radii = [];
     return drawImage.apply(this, args);
   };
   const move = prototype.moveTo;
   const line = prototype.lineTo;
   let routeStart;
   prototype.moveTo = function (x, y) {
     if (this.strokeStyle === '#b9a4ff') routeStart = {x, y};
     return move.call(this, x, y);
   };
   prototype.lineTo = function (x, y) {
     if (this.strokeStyle === '#b9a4ff') window.routeDraw.segments.push(Math.hypot(x - routeStart.x, y - routeStart.y));
     return line.call(this, x, y);
   };
   context.moveTo = function (x, y) {
     start = {x, y};
     return moveTo.call(this, x, y);
   };
   context.lineTo = function (x, y) {
     if (start) length = Math.hypot(x - start.x, y - start.y);
     vertices.push({x, y});
     return lineTo.call(this, x, y);
   };
   context.stroke = function (...args) {
     if (!document.getElementById('estimatedLocation').hidden && this.strokeStyle === '#ffca80'
       && this.lineWidth === 2 && this.getLineDash().length === 0) {
       window.estimatedCourseLength = length;
       window.estimatedCourseStart = start.x;
       window.estimatedArrowTips = [];
     }
     if (!document.getElementById('estimatedLocation').hidden && this.strokeStyle === '#ffca80'
       && this.lineWidth === 1.5) window.estimatedArrowTips = vertices.filter((_, i) => i % 2 === 0);
     return stroke.apply(this, args);
   };
   context.arc = function (x, y, radius, ...args) {
     if (this.fillStyle === '#b9a4ff') window.routeDraw?.radii.push(radius);
     return arc.call(this, x, y, radius, ...args);
   };
   context.fillText = function (value, ...args) {
     if (this.fillStyle === '#101625') window.routeDraw?.labels.push(value);
     return fillText.call(this, value, ...args);
   };
 });
 await page.evaluate(() => window.hideSurvey());
 await page.waitForFunction(() => document.getElementById('position').textContent === '인식 실패');
 assert.ok(await page.locator('#estimatedLocation').isHidden());
 await page.locator('#estimatedLocation').waitFor({state:'visible'});
 assert.equal(await page.locator('#course').textContent(), '90.0°');
 const fixedLength = await page.evaluate(() => window.estimatedCourseLength);
 assert.ok(fixedLength > 0);
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await generalTab.click();
 await lineLengthMode.selectOption('days');
 assert.equal(await lineDays.isVisible(), true);
 assert.equal(await lineLength.isVisible(), false);
 await lineDays.fill('0');
 await saveSettings.click();
 assert.equal(await lineDays.evaluate(input => input.validity.rangeUnderflow), true);
 assert.equal(await page.evaluate(() => window.estimatedCourseLength), fixedLength);
 await lineDays.fill('2');
 await saveSettings.click();
 await page.waitForFunction(fixed => window.estimatedCourseLength > 0 && window.estimatedCourseLength !== fixed, fixedLength);
 const twoDayLength = await page.evaluate(() => window.estimatedCourseLength);
 await page.waitForFunction(length => {
   const tips = window.estimatedArrowTips;
   return tips?.length >= 2 && Math.abs(tips[1].x - tips[0].x - length / 2) < 0.001;
 }, twoDayLength);
 await adjustSailingTime.check();
 await saveSettings.click();
 await page.evaluate(() => window.hideSurvey(2));
 await page.waitForFunction(length => {
   const tips = window.estimatedArrowTips;
   const firstDistance = tips?.[0]?.x - window.estimatedCourseStart;
   return firstDistance > 0 && firstDistance < length / 2 - 0.01
     && tips.length >= 2 && Math.abs(tips[1].x - tips[0].x - length / 2) < 0.001;
 }, twoDayLength);
 await showDayArrows.uncheck();
 assert.equal(await adjustSailingTime.isDisabled(), true);
 await saveSettings.click();
 await page.waitForFunction(() => window.estimatedArrowTips?.length === 0);
 await showDayArrows.check();
 await saveSettings.click();
 await lineDays.fill('1');
 await saveSettings.click();
 await page.waitForFunction(double => Math.abs(window.estimatedCourseLength * 2 - double) < 0.001, twoDayLength);
 await page.locator('#closeSettings').click();
 await page.waitForTimeout(6500);
 assert.ok(await page.locator('#estimatedLocation').isVisible());
 const beforeSurveyRecovery = await page.evaluate(() => window.routeDraw.segments.length);
 await page.evaluate(() => window.showRouteFix('4400, 6543', 2));
 await page.waitForFunction(() => document.getElementById('position').textContent === '4400 / 6543');
 await page.waitForFunction(count => window.routeDraw.segments.length > count, beforeSurveyRecovery,
   {timeout: 3000}).catch(error => {
   throw new Error('The route must resume from the last measured point while the sailing day stays visible', {cause: error});
 });
 await page.evaluate(() => window.hideSailingDay());
 await page.waitForFunction(() => document.getElementById('position').textContent === '인식 실패');
 await page.waitForTimeout(6200);
 await page.locator('#estimatedLocation').waitFor({state:'hidden', timeout:7000});

 await page.locator('#mapZoomLevel').fill('50');
 await page.locator('#mapZoomLevel').press('Tab');
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 const beforeVoyageRestart = await page.evaluate(() => window.routeDraw.segments.length);
 await page.evaluate(() => window.showRouteFix('16380, 6543', 1));
 await page.waitForFunction(() => document.getElementById('position').textContent === '16380 / 6543');
 assert.equal(await page.evaluate(() => window.routeDraw.segments.length), beforeVoyageRestart);
 await page.evaluate(() => window.showRouteFix('5, 6543', 2));
 await page.waitForFunction(() => document.getElementById('position').textContent === '5 / 6543'
   && window.routeDraw.radii.filter(radius => radius === 2).length >= 2 && window.routeDraw.labels.length === 0);
 assert.ok(await page.evaluate(() => window.routeDraw.segments.at(-1) < 2), 'route wraps across the map seam');
 await page.evaluate(() => window.showRouteFix('150, 6543', 5));
 await page.waitForFunction(() => window.routeDraw.labels.includes('5'));
 assert.ok(await page.evaluate(() => window.routeDraw.radii.includes(6)));
 await page.evaluate(() => window.showRouteFix('160, 6543', null));
 await page.waitForFunction(() => document.getElementById('position').textContent === '160 / 6543');
 await page.waitForTimeout(6200);
 const beforeDayLoss = await page.evaluate(() => window.routeDraw.segments.length);
 await page.evaluate(() => window.showRouteFix('170, 6543', null));
 await page.waitForFunction(() => document.getElementById('position').textContent === '170 / 6543');
 await page.waitForFunction(count => window.routeDraw.segments.length > count, beforeDayLoss, {timeout: 3000})
   .catch(error => {
     throw new Error('Valid survey coordinates must keep extending the route after the sailing-day read expires', {cause: error});
   });
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await generalTab.click();
 await routeDayInterval.selectOption('1');
 await saveSettings.click();
 await page.waitForFunction(() => window.routeDraw.labels.includes('2') && window.routeDraw.labels.includes('5'));
 await routeDayInterval.selectOption('0');
 await saveSettings.click();
 await page.waitForFunction(() => window.routeDraw.labels.length === 0 && window.routeDraw.radii.includes(2));
 await page.locator('#closeSettings').click();

 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 await page.waitForFunction(() => document.getElementById('recognitionTab').getAttribute('aria-selected') === 'true');
 await page.locator('#captureTab').click();
 await page.locator('#compassRegion').click();
 await page.evaluate(() => window.resizeTestCapture());
 await page.waitForFunction(() => document.getElementById('capture').width === 800);
 await page.waitForFunction(() => document.getElementById('position').textContent === '4321 / 6543');
 const resizedAngle = parseFloat(await page.locator('#heading').textContent());
 assert.ok(Math.abs(resizedAngle - gameAngle) < 3, `resized heading ${resizedAngle}`);
 assert.equal(await page.locator('#course').textContent(), '—°');
 assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
 assert.equal(await page.locator('#capture.selecting').count(), 0);
 assert.deepEqual(await page.locator('[data-share-status]').allTextContents(), ['게임 화면 공유 중', '게임 화면 공유 중']);
 await shareStop.click();
 assert.deepEqual(await page.locator('[data-share-status]').allTextContents(), ['연결 대기', '연결 대기']);
 assert.equal(await mapShare.textContent(), '게임 화면 공유');
 assert.equal(await mapCompassShare.isHidden(), true);
 assert.equal(await shareStart.isVisible(), true);
 assert.equal(await shareStop.count(), 0);
 await expectReset(page);
 assert.ok(await page.evaluate(() => window.routeDraw.segments.length > 0));

 await page.locator('#recognitionTab').click();
 assert.equal(await shareStart.isVisible(), true);
 await page.locator('#offset').fill('21');
 await page.locator('#recognitionFps').fill('10');
 const fpsSlider = page.locator('#recognitionFpsSlider');
 assert.equal(await fpsSlider.inputValue(), '10');
 await fpsSlider.press('Home');
 assert.equal(await page.locator('#recognitionFps').inputValue(), '1');
 await fpsSlider.press('End');
 await averageSlider.press('End');
 assert.equal(await page.locator('#motionAverageValue').textContent(), '60초');
 await saveSettings.click();
 await page.locator('#offset').fill('33');
 await page.reload();
 await page.locator('#toggleMapSidebar').click();
 await page.locator('#openSettings').click();
 await page.locator('#recognitionTab').click();
 assert.equal(await page.locator('#offset').inputValue(), '21');
 assert.equal(await page.locator('#bearingStep').inputValue(), '0.1');
 await generalTab.click();
 assert.equal(await speedUnit.inputValue(), 'knot');
 assert.equal(await speedUnitLabel.textContent(), 'knot');
 assert.equal(await lineLengthMode.inputValue(), 'days');
 assert.equal(await lineDays.inputValue(), '1');
 assert.equal(await lineLength.isVisible(), false);
 assert.equal(await adjustSailingTime.isChecked(), true);
 assert.equal(await routeDayInterval.inputValue(), '0');
 assert.equal(await page.locator('#recognitionFps').inputValue(), '10');
 assert.equal(await fpsSlider.inputValue(), '10');
 assert.equal(await averageSlider.inputValue(), '60');
 await resetSettings.click();
 assert.equal(await page.locator('#bearingStep').inputValue(), '0.1');
 assert.equal(await speedUnit.inputValue(), 'coordinatesPerMinute');
 assert.equal(await speedUnitLabel.textContent(), 'knot');
 assert.equal(await lineLengthMode.inputValue(), 'fixed');
 assert.equal(await lineLength.isVisible(), true);
 assert.equal(await lineLength.inputValue(), '16384');
 assert.equal(await adjustSailingTime.isChecked(), false);
 assert.equal(await routeDayInterval.inputValue(), '5');
 assert.equal(await fpsSlider.inputValue(), '10');
 assert.equal(await page.locator('#motionAverageValue').textContent(), '60초');
 await cancelSettings.click();
 assert.equal(await fpsSlider.inputValue(), '10');
 assert.equal(await page.locator('#motionAverageValue').textContent(), '60초');
 assert.equal(await lineLengthMode.inputValue(), 'days');
 assert.equal(await lineDays.isVisible(), true);
 assert.equal(await speedUnit.inputValue(), 'knot');
 assert.equal(await adjustSailingTime.isChecked(), true);
 assert.equal(await saveSettings.isVisible(), false);

 await page.locator('#closeSettings').click();
 await page.locator('#openRoutePlanner').click();
 const departure = page.getByRole('combobox', {name: '출발지'});
 const arrival = page.getByRole('combobox', {name: '목적지'});
 await page.getByRole('button', {name: '출발지 목록 열기'}).click();
 assert.ok(await page.locator('#routeStartList [role="option"]').count() > 100);
 await departure.fill('스턴');
 assert.deepEqual(await page.locator('#routeStartList [role="option"]').allTextContents(), ['보스턴']);
 await departure.press('ArrowDown');
 await departure.press('Enter');
 assert.equal(await departure.inputValue(), '보스턴');
 await arrival.fill('블린');
 await page.getByRole('option', {name: '더블린', exact: true}).click();
 await page.locator('#calculateRoute').click();
 await page.waitForFunction(() => document.getElementById('plannedRouteSummary').textContent.includes('보스턴 → 더블린'));
 assert.match(await page.locator('#plannedRouteSummary').textContent(), /보스턴 → 더블린/);

 await arrival.fill('카이');
 await page.getByRole('option', {name: '사카이', exact: true}).click();
 await page.locator('#routeObjective').selectOption({label: '최소 선회'});
 await page.locator('#calculateRoute').click();
 await page.waitForFunction(() => document.getElementById('plannedRouteSummary').textContent.includes('보스턴 → 사카이'));
 assert.match(await page.locator('#plannedRouteSummary').textContent(), /보스턴 → 사카이/);
 assert.match(await page.locator('#plannedRouteEstimate').textContent(), /^최소 선회 · 선회 [1-9]회/);

 assert.deepEqual(errors,[]);
 console.log('PASS: share controls, settings, map, HUD OCR, resize, cleanup, city search and minimum turns');
}finally{await browser.close();}
