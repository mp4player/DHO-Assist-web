import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

await mkdir('test-results', {recursive: true});
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, headless: true});
try {
  for (const viewport of [{width: 1440, height: 1000}, {width: 390, height: 844}]) {
    const page = await browser.newPage({viewport});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5198');
    await page.waitForFunction(() => document.querySelector('#mapSidebar').dataset.arrowPosition === 'top');
    const toggle = page.locator('#toggleMapSidebar');
    assert.equal(await page.locator('#mapSidebarBody').isVisible(), false);
    assert.equal(await page.locator('#mapSidebar').evaluate(sidebar => sidebar.clientWidth), 0);
    const alpha = () => toggle.evaluate(button => {
      const color = getComputedStyle(button).backgroundColor;
      return color.startsWith('rgba') ? Number(color.split(',').at(-1).replace(')', '')) : 1;
    });
    await page.mouse.move(viewport.width - 5, viewport.height - 5);
    await page.waitForTimeout(350);
    assert.equal(await alpha(), 0);
    const bounds = await toggle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForTimeout(350);
    assert.ok(await alpha() > .8, 'The semicircle must fade in near the pointer');
    await page.screenshot({path: `test-results/sidebar-hover-${viewport.width}.png`});
    await page.mouse.move(viewport.width - 5, viewport.height - 5);
    await page.waitForTimeout(350);
    assert.equal(await alpha(), 0);
    await page.screenshot({path: `test-results/sidebar-collapsed-${viewport.width}.png`});
    assert.equal(await toggle.evaluate(button => getComputedStyle(button).borderTopWidth), '0px');
    assert.equal(bounds.height, bounds.width * 2);

    await toggle.click();
    assert.equal(await page.locator('#mapSidebarBody #openSettings').count(), 1);
    const bodyBounds = await page.locator('#mapSidebarBody').boundingBox();
    const settingsBounds = await page.locator('#openSettings').boundingBox();
    assert.ok(Math.abs(bodyBounds.y + bodyBounds.height - settingsBounds.y - settingsBounds.height) <= 14);
    await page.locator('#openSettings').click();
    assert.deepEqual(await page.locator('#settingsTabs button').allTextContents(), ['기본', '인식 상태', '화면 및 영역']);
    await page.waitForFunction(() => document.querySelector('#generalTab').getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('#settingsDialog').evaluate(panel => panel.tagName), 'DIALOG');
    await page.locator('#generalTab').click();
    assert.equal(await page.locator('#generalTab').textContent(), '기본');
    const positions = page.locator('#sidebarArrowPosition');
    assert.deepEqual(await positions.locator('option').allTextContents(), ['상단', '중앙', '하단']);
    assert.equal(await positions.inputValue(), 'top');
    for (const position of ['center', 'bottom', 'top']) {
      await positions.selectOption(position);
      assert.notEqual(await page.locator('#mapSidebar').getAttribute('data-arrow-position'), position);
      await page.locator('#saveSettings').click();
      const actual = await toggle.boundingBox();
      const map = await page.locator('#map').boundingBox();
      const target = position === 'top' ? map.y : position === 'bottom' ? map.y + map.height - actual.height : map.y + (map.height - actual.height) / 2;
      assert.ok(Math.abs(actual.y - target) < 1, `${position} position`);
    }
    await positions.selectOption('bottom');
    await page.locator('#cancelSettings').click();
    assert.equal(await positions.inputValue(), 'top');
    await positions.selectOption('center');
    await page.locator('#saveSettings').click();
    await page.reload();
    assert.equal(await page.locator('#mapSidebarBody').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#mapSidebar').dataset.arrowPosition === 'center');
    await toggle.click();
    await page.locator('#openSettings').click();
    await page.locator('#generalTab').click();
    assert.equal(await positions.inputValue(), 'center');
    await page.locator('#resetSettings').click();
    assert.equal(await positions.inputValue(), 'top');
    await page.locator('#cancelSettings').click();
    assert.equal(await positions.inputValue(), 'center');

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsDialog').evaluate(panel => panel.open), false);
    await page.locator('#openRoutePlanner').click();
    await page.waitForFunction(() => !document.querySelector('#settingsDialog').open);
    await page.locator('#routeStart').fill('스턴');
    await page.getByRole('option', {name: '보스턴', exact: true}).click();
    await page.locator('#routeDestination').fill('블린');
    await page.getByRole('option', {name: '더블린', exact: true}).click();
    await page.locator('#calculateRoute').click();
    await page.waitForFunction(() => document.querySelector('#plannedRouteSummary').textContent.includes('보스턴 → 더블린'));
    await page.locator('#openSettings').click();
    assert.equal(await page.locator('#settingsDialog').evaluate(panel => panel.open), true);
    await page.locator('#captureTab').click();
    await page.getByRole('button', {name: '데모 화면', exact: true}).click();
    await page.locator('#recognitionTab').click();
    await page.getByRole('button', {name: '한 번 인식', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#position').textContent === '12345 / 3456', null, {timeout: 90000});
    await page.locator('#track').click();
    await page.locator('#closeSettings').click();
    await toggle.click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#track').textContent(), '연속 인식 중지');
    assert.equal(await page.locator('#heading').textContent(), '60°');
    await toggle.click();
    await page.locator('#openSettings').click();
    await page.locator('#recognitionTab').click();
    await page.locator('#track').click();
    await mkdir('test-results', {recursive: true});
    await page.screenshot({path: `test-results/sidebar-${viewport.width}.png`});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`Sidebar ${viewport.width}px: position, persistence, fade, popup settings, city search, demo OCR and recognition while collapsed passed`);
    await page.close();
  }
} finally {
  await browser.close();
}
