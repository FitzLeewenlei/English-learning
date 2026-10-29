const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {gzipSync} = require('node:zlib');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const read = file => fs.readFileSync(path.join(root, file));
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const tokens = /[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
const plain = value => JSON.parse(JSON.stringify(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function scripts(files) {
  const sandbox = {window: {}};
  vm.createContext(sandbox);
  for (const file of files) vm.runInContext(read(file).toString(), sandbox);
  return plain(sandbox.window);
}
const full = scripts(['content.js', 'dictionary.js', 'sentence-timings.js']);
const initial = scripts(['course-index.js']);
const numbers = Array.from({length: 120}, (_, i) => i + 1);
assert.deepEqual(initial.COURSE.availableUnits, numbers);
assert.deepEqual(Object.keys(initial.COURSE.lists), ['1'], 'Only the first unit should be embedded for immediate display');
assert.deepEqual(initial.COURSE.source, full.COURSE.source);
let bundleBytes = 0;
for (const number of numbers) {
  const file = initial.COURSE.unitFiles[number];
  const match = /^data\/units\/unit-(\d+)-([a-f0-9]{12})\.json$/.exec(file);
  assert.ok(match, `Unit ${number}: content-addressed local bundle path`);
  assert.equal(Number(match[1]), number);
  const bytes = read(file);
  assert.equal(hash(bytes).slice(0, 12), match[2], `Unit ${number}: filename matches actual payload hash`);
  const bundle = JSON.parse(bytes);
  assert.equal(bundle.number, number);
  assert.deepEqual(bundle.unit, full.COURSE.lists[number], `Unit ${number}: full original document facts and media bindings`);
  const words = new Set(bundle.unit.vocabulary.map(entry => normalize(entry.word)));
  for (const example of bundle.unit.examples) for (const word of example.speechText.match(tokens) || []) words.add(normalize(word));
  assert.deepEqual(Object.keys(bundle.dictionary).sort(), [...words].sort(), `Unit ${number}: dictionary covers every displayed/spoken token`);
  for (const word of words) assert.deepEqual(bundle.dictionary[word], full.WORD_DICTIONARY[word], `Unit ${number}: ${word} source fields unchanged`);
  const paths = new Set(bundle.unit.examples.map(entry => entry.audio));
  assert.deepEqual(Object.keys(bundle.timings).sort(), [...paths].sort());
  for (const audio of paths) assert.deepEqual(bundle.timings[audio], full.SENTENCE_TIMINGS[audio], `Unit ${number}: unchanged word boundary data`);
  if (number === 1) {
    assert.deepEqual(initial.COURSE.lists[1], bundle.unit);
    assert.deepEqual(initial.WORD_DICTIONARY, bundle.dictionary);
    assert.deepEqual(initial.SENTENCE_TIMINGS, bundle.timings);
  }
  bundleBytes += bytes.length;
}
const oldScripts = ['content.js', 'dictionary.js', 'sentence-timings.js', 'app.js'];
const newScripts = ['course-index.js', 'app.js'];
const bytesFor = files => files.reduce((sum, file) => sum + read(file).length, 0);
const gzipFor = files => files.reduce((sum, file) => sum + gzipSync(read(file)).length, 0);
const oldBytes = bytesFor(oldScripts), initialBytes = bytesFor(newScripts);
assert.ok(initialBytes < oldBytes / 10, `Initial scripts must drop at least90%: ${initialBytes} vs ${oldBytes}`);
assert.ok(gzipFor(newScripts) < gzipFor(oldScripts) / 10, 'Compressed initial script bytes must also drop at least90%');
console.log(JSON.stringify({bundleDataParity: 'all120 units, dictionary source records and exact sentence timings', bundleBytes,
  previousInitialScriptBytes: oldBytes, initialScriptBytes: initialBytes,
  previousGzipScriptBytes: gzipFor(oldScripts), initialGzipScriptBytes: gzipFor(newScripts)}));

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const pages = [];
  const errors = [];
  const waitForUnit = (page, number) => page.waitForFunction(expected =>
    document.querySelector('#current-list').textContent === `Unit ${expected}`
      && document.querySelector('main').getAttribute('aria-busy') !== 'true', String(number));
  const select = async (page, number) => {
    await page.selectOption('#list-select', String(number));
    await waitForUnit(page, number);
  };
  const makePage = async () => {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    pages.push(page);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = function(...args) {const audio = new NativeAudio(...args); window.__audio = audio; return audio;};
    });
    return page;
  };
  try {
    const page = await makePage();
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.route(/\/(?:content|dictionary|sentence-timings)\.js(?:\?|$)/, route => route.abort());
    await page.goto(baseURL, {waitUntil: 'networkidle'});
    await waitForUnit(page, 1);
    assert.equal(await page.locator('.word-card').count(), 15);
    assert.equal(await page.locator('.example-row').count(), 15);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.COURSE.lists)), ['1']);
    assert.equal(requests.filter(file => /\/(?:content|dictionary|sentence-timings)\.js$/.test(file)).length, 0, 'No large aggregate script request');
    assert.equal(requests.filter(file => /\/data\/units\//.test(file)).length, 0, 'The embedded first unit needs no extra round trip');
    assert.equal(requests.filter(file => /\/audio\//.test(file)).length, 0, 'No audio download before a playback gesture');
    const chunkRequests = () => requests.filter(file => /\/data\/units\//.test(file));
    await select(page, 120);
    assert.equal(chunkRequests().length, 1, 'Only the chosen unit is fetched');
    assert.deepEqual(await page.evaluate(() => Object.keys(window.COURSE.lists)), ['1', '120']);
    assert.equal(await page.locator('.word-name').first().textContent(), full.COURSE.lists[120].vocabulary[0].word);
    assert.equal(requests.filter(file => /\/audio\//.test(file)).length, 0);
    await page.locator('#vocab-0').click();
    await page.waitForFunction(() => window.__audio.currentTime > 0 && !window.__audio.paused);
    const expectedWord = full.WORD_DICTIONARY[normalize(full.COURSE.lists[120].vocabulary[0].word)];
    assert.equal(await page.evaluate(() => window.__audio.currentSrc), new URL(expectedWord.audio, baseURL).href);
    await page.keyboard.press('Escape');
    await page.locator('.sentence-play').first().click();
    await page.waitForFunction(() => document.querySelector('#sentence-focus').open && window.__audio.currentTime > 0);
    assert.equal(await page.locator('#focus-sentence').textContent(), full.COURSE.lists[120].examples[0].speechText);
    assert.equal(await page.locator('.focus-word').count(), full.SENTENCE_TIMINGS[full.COURSE.lists[120].examples[0].audio].words.length);
    await page.keyboard.press('Escape');
    await select(page, 1);
    await select(page, 120);
    assert.equal(chunkRequests().length, 1, 'Loaded units are reused in memory');
    await page.reload({waitUntil: 'networkidle'});
    await waitForUnit(page, 120);
    assert.equal(await page.locator('#list-select').inputValue(), '120', 'Remembered unit is restored after asynchronous loading');
    console.log('Initial load: only first-unit data, no aggregate scripts or eager audio; lazy Unit120 word/sentence audio, cache reuse and remembered selection passed.');

    async function checkRapidSelection(failStale) {
      const rapid = await makePage();
      let release;
      const held = new Promise(resolve => {release = resolve;});
      await rapid.route('**/data/units/*.json', async route => {
        if (/\/unit-120-/.test(route.request().url())) {
          await held;
          if (failStale) return route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"temporary"}'});
        }
        await route.continue();
      });
      await rapid.goto(baseURL, {waitUntil: 'networkidle'});
      const started = rapid.waitForRequest(request => /\/unit-120-/.test(request.url()));
      await rapid.selectOption('#list-select', '120');
      await started;
      assert.equal(await rapid.locator('main').getAttribute('aria-busy'), 'true');
      await select(rapid, 33);
      const completed = rapid.waitForResponse(response => /\/unit-120-/.test(response.url()));
      release();
      const response = await completed;
      await response.finished();
      // Give the application the completed fetch promise, then inspect the latest
      // rendered selection rather than relying only on the select's own value.
      await rapid.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await rapid.locator('#current-list').textContent(), 'Unit 33');
      assert.equal(await rapid.locator('#list-select').inputValue(), '33');
      assert.equal(await rapid.evaluate(() => localStorage.getItem('english-reader-list')), '33');
      assert.notEqual(await rapid.locator('main').getAttribute('aria-busy'), 'true');
      assert.equal((await rapid.getByRole('status').allTextContents()).some(text => /Unit 120/.test(text) && /未能加载|加载失败/.test(text)), false);
      await rapid.close();
    }
    await checkRapidSelection(false);
    await checkRapidSelection(true);
    console.log('Rapid selection: delayed Unit120 success and failure cannot overwrite the newer Unit33 selection or show a stale error.');

    const retry = await makePage();
    let attempts = 0;
    await retry.route('**/data/units/*.json', async route => {
      if (/\/unit-33-/.test(route.request().url()) && ++attempts === 1) {
        await route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"temporary"}'});
      } else await route.continue();
    });
    await retry.goto(baseURL, {waitUntil: 'networkidle'});
    const failed = retry.waitForResponse(response => /\/unit-33-/.test(response.url()) && response.status() === 503);
    await retry.selectOption('#list-select', '33');
    await failed;
    await retry.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') !== 'true'
      && document.querySelector('#list-select').value === '1');
    assert.equal(await retry.locator('#current-list').textContent(), 'Unit 1');
    assert.equal(await retry.locator('.word-name').first().textContent(), full.COURSE.lists[1].vocabulary[0].word);
    assert.equal(await retry.locator('#vocabulary').evaluate(node => node.inert), false);
    assert.ok((await retry.getByRole('status').allTextContents()).some(text => /未能加载|加载失败/.test(text)), 'A failed download must show an explicit status');
    await select(retry, 33);
    assert.equal(attempts, 2, 'Failed loads are evicted so the user can retry');
    assert.equal(await retry.locator('.word-name').first().textContent(), full.COURSE.lists[33].vocabulary[0].word);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({allUnitBundleParity: 'passed', initialScriptReduction: (100 * (1 - initialBytes / oldBytes)).toFixed(1) + '%',
      initialAggregateRequests: 0, initialAudioRequests: 0, onDemandLoading: 'passed', loadedUnitReuse: 'passed',
      rapidSelectionSuccessAndFailure: 'passed', failedLoadRecoveryAndRetry: 'passed', rememberedUnit: 'passed', browserErrors: errors}));
  } finally {
    await Promise.all(pages.filter(page => !page.isClosed()).map(page => page.close()));
    await browser.close();
  }
})().catch(error => {console.error(error); process.exit(1);});
