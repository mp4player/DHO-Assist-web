import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

async function expectReset(page) {
  assert.equal(await page.locator('#position').textContent(), '— / —');
  assert.equal(await page.locator('#heading').textContent(), '—°');
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
  const fixedCanvas = await page.addStyleTag({content: '#map { width: 1202px; height: 602px; }'});
  await page.waitForFunction(() => {
    const {width, height} = document.getElementById('map');
    return width === 1200 && height === 600;
  });
  await page.locator('#openSettings').click();
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
  assert.equal(await page.locator('#mapZoomLevel').textContent(), '125%');
  await page.locator('#mapZoomOut').click();
  await expectPixel(290, 300, red);
  await page.locator('#mapZoomOut').click();
  assert.equal(await page.locator('#mapZoomLevel').textContent(), '80%');
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
  await page.locator('#originX').fill('0');
  await page.locator('#saveSettings').click();
  await page.locator('#closeSettings').click();
  await fixedCanvas.evaluate(style => style.remove());

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
  await page.locator('#openSettings').click();
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
 assert.equal(await page.locator('#settingsDialog').isVisible(), false);
 await page.getByRole('button', {name:'설정', exact:true}).click();
 assert.equal(await page.getByRole('dialog', {name:'설정'}).isVisible(), true);
 const shareStart = page.getByRole('button', {name:'게임 화면 공유', exact:true});
 const shareChange = page.getByRole('button', {name:'게임 화면 변경', exact:true});
 const shareStop = page.getByRole('button', {name:'공유 종료', exact:true});
 const resetSettings = page.getByRole('button', {name:'설정 초기화', exact:true});
 const saveSettings = page.getByRole('button', {name:'변경사항 저장', exact:true});
 const cancelSettings = page.getByRole('button', {name:'변경사항 취소', exact:true});
 assert.equal(await page.locator('#recognitionTab').getAttribute('aria-selected'), 'true');
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 공유']);
 assert.equal(await page.getByRole('combobox', {name:'공유 대상 선택'}).count(), 0);
 assert.equal(await page.locator('#capture').isVisible(), false);
 await page.locator('#recognitionTab').press('ArrowRight');
 assert.equal(await page.locator('#captureTab').getAttribute('aria-selected'), 'true');
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 공유']);
 await page.getByRole('button',{name:'데모 화면',exact:true}).click();await page.waitForTimeout(200);
 await page.locator('#captureTab').press('Home');
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
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#settingsDialog').isVisible(), false);
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
   function drawHud(width, height, coordinates) {
     canvas.width = width;
     canvas.height = height;
     context.fillStyle = '#284254';
     context.fillRect(0, 0, width, height);
     context.font = '13px Arial';
     context.textAlign = 'right';
     context.fillStyle = '#fff';
     context.fillText(coordinates, width - 13, height - 264, 56);

     const compassX = width - 148 + 56;
     const compassY = height - 108 + 39;
     context.beginPath();
     context.ellipse(compassX, compassY + 11, 54, 49, 0, 0, 2 * Math.PI);
     context.fillStyle = '#526b50';
     context.fill();
     context.fillStyle = '#ffff53';
     context.fillRect(compassX + 37, compassY - 20, 7, 7);
   }

   drawHud(960, 540, '1234, 3456');
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
   window.resizeTestCapture = () => drawHud(800, 450, '4321, 6543');
 });

 await shareStart.click();
 await page.waitForFunction(() => document.getElementById('message').textContent.includes('Test picker cancelled'));
 await page.locator('#captureTab').click();
 assert.equal(await resetSettings.isVisible(), true);
 await shareStart.click();
 await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-share-status]')).every(status => status.textContent === '게임 화면 공유 중'));
 assert.deepEqual(await page.evaluate(() => window.shareRequests), [
   {video: {displaySurface: 'window'}, audio: false},
   {video: {displaySurface: 'window'}, audio: false},
 ]);
 assert.deepEqual(await page.getByRole('group', {name: '화면 연결'}).getByRole('button').allTextContents(), ['게임 화면 변경', '공유 종료']);
 await shareChange.click();
 await page.waitForFunction(() => document.getElementById('screenMessage').textContent.includes('Test picker cancelled'));
 assert.equal(await shareChange.isVisible(), true);
 assert.equal(await shareStop.isVisible(), true);
 await page.locator('#recognitionTab').click();
 assert.equal(await page.getByRole('group', {name: '화면 연결'}).count(), 0);
 assert.match(await page.locator('#selectionHint').textContent(), /자동으로 사용합니다/);
 await page.locator('#once').click();
 await page.waitForFunction(() => document.getElementById('state').textContent === '인식 완료');
 assert.equal(await page.locator('#position').textContent(), '1234 / 3456');
 assert.match(await page.locator('#raw').textContent(), /OCR 신뢰도/);
 const gameAngle = parseFloat(await page.locator('#heading').textContent());
 assert.ok(Math.abs(gameAngle - 296) < 4, `game heading ${gameAngle}`);

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
 await page.waitForFunction(() => document.getElementById('state').textContent === '인식 완료');
 await page.locator('#closeSettings').click();
 await page.waitForFunction(() => document.getElementById('speed').textContent === '0.0');
 assert.equal(await page.locator('#course').textContent(), '—°');
 await page.evaluate(() => window.moveTestCapture());
 await page.waitForFunction(() => document.getElementById('course').textContent === '135.0°');
 assert.ok(parseFloat(await page.locator('#speed').textContent()) > 0);
 assert.ok(Math.abs(parseFloat(await page.locator('#heading').textContent()) - gameAngle) < 3);

 await page.locator('#openSettings').click();
 assert.equal(await page.locator('#recognitionTab').getAttribute('aria-selected'), 'true');
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
 assert.equal(await shareStart.isVisible(), true);
 assert.equal(await shareStop.count(), 0);
 await expectReset(page);

 await page.locator('#recognitionTab').click();
 assert.equal(await shareStart.isVisible(), true);
 await page.locator('#offset').fill('21');
 await saveSettings.click();
 await page.locator('#offset').fill('33');
 await page.reload();
 await page.locator('#openSettings').click();
 assert.equal(await page.locator('#offset').inputValue(), '21');
 assert.equal(await saveSettings.isVisible(), false);

 assert.deepEqual(errors,[]);
 console.log('PASS: contextual share controls, draft settings, map, HUD OCR, resize and cleanup');
}finally{await browser.close();}
