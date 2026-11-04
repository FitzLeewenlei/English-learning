const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const delayMs = 350;
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sandbox = {window: {}};
vm.createContext(sandbox);
for (const file of ['content.js', 'dictionary.js', 'sentence-timings.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
const full = JSON.parse(JSON.stringify(sandbox.window));
const firstUnit = full.COURSE.lists[1];
const sourceFor = index => full.WORD_DICTIONARY[normalize(firstUnit.vocabulary[index].word)].audio;
const allowedFirstUnit = new Set([...firstUnit.vocabulary.map((_, index) => sourceFor(index)), ...firstUnit.examples.map(entry => entry.audio)]);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const errors = [];
  const pages = [];
  async function instrument(page) {
    pages.push(page);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    // The collector and public script are external to this audio regression.
    await page.route('https://static.cloudflareinsights.com/**', route => route.abort());
    await page.addInitScript(() => {
      window.__audioEvents = [];
      window.__createdAudioBlobs = [];
      const createURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => {
        const url = createURL(blob);
        window.__createdAudioBlobs.push({url, bytes: blob.size});
        return url;
      };
      const AudioClass = window.Audio;
      window.Audio = function(...args) {
        const audio = new AudioClass(...args);
        window.__audio = audio;
        audio.addEventListener('playing', () => {
          const record = window.__audioEvents.at(-1);
          if (!record || record.playingMs !== undefined) return;
          record.playingMs = performance.now() - record.clickedAt;
          record.startPosition = audio.currentTime;
          record.source = audio.dataset.source || audio.currentSrc;
          record.currentSrc = audio.currentSrc;
          record.rate = audio.playbackRate;
        });
        return audio;
      };
      document.addEventListener('click', event => {
        const button = event.target.closest('.word-card, .sentence-play, #word-detail-play');
        if (button) window.__audioEvents.push({clickedAt: performance.now(), label: button.getAttribute('aria-label')});
      }, true);
    });
  }
  async function serveAudio(page, requests, failWarm = () => false, corruptWarm = () => false) {
    await page.route('**/audio/**', async route => {
      const request = route.request();
      const source = new URL(request.url()).pathname.match(/\/(audio\/.*)$/)?.[1];
      assert.ok(source, request.url());
      requests.push({source, resourceType: request.resourceType(), at: Date.now()});
      if (request.resourceType() === 'fetch' && failWarm(source)) {
        return route.fulfill({status: 503, contentType: 'text/plain', body: 'Temporary prefetch failure'});
      }
      if (request.resourceType() === 'fetch' && corruptWarm(source)) {
        return route.fulfill({status: 200, contentType: 'audio/mpeg', body: 'Not a decodable audio recording'});
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      await route.fulfill({status: 200, contentType: source.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
        headers: {'cache-control': 'public, max-age=3600'}, body: fs.readFileSync(path.join(root, source))});
    });
  }
  async function clickAndMeasure(page, selector) {
    const previous = await page.evaluate(() => window.__audioEvents.length);
    await page.locator(selector).click();
    await page.waitForFunction(index => window.__audioEvents[index]?.playingMs !== undefined, previous);
    const event = await page.evaluate(index => window.__audioEvents[index], previous);
    assert.equal(await page.locator('#notice').isVisible(), false, 'Playback must succeed');
    return event;
  }
  async function blobMatchesSource(page, event) {
    assert.match(event.currentSrc, /^blob:/, 'A prepared recording must play from the retained blob');
    const actual = await page.evaluate(async url => {
      const bytes = await (await fetch(url)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }, event.currentSrc);
    assert.equal(actual, hash(fs.readFileSync(path.join(root, event.source))), 'Prepared audio must preserve every original source byte');
  }
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    await instrument(page);
    const requests = [];
    await serveAudio(page, requests);
    await page.goto(baseURL, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.querySelectorAll('.word-card').length === 15);
    await page.waitForTimeout(2000);
    assert.ok(requests.length > 0 && requests.length <= 6, 'Background work is bounded to four visible words and two visible examples');
    assert.ok(requests.every(request => allowedFirstUnit.has(request.source)), 'Preparation never fetches another unit');
    const requestsBeforeWarm = requests.length;
    const warm = [];
    let checkedStartOffsets = 0;
    for (const index of [0, 1, 2]) {
      const event = await clickAndMeasure(page, '#vocab-' + index);
      assert.equal(event.source, sourceFor(index));
      await blobMatchesSource(page, event);
      const offset = await page.evaluate(source => window.AUDIO_STARTS?.[source] || 0, event.source);
      assert.ok(offset >= 0 && offset <= .45);
      if (offset) {
        assert.ok(event.startPosition >= offset - .025 && event.startPosition < offset + .15,
          `Audited initial silence is skipped safely: ${event.startPosition} vs ${offset}`);
        checkedStartOffsets++;
      }
      warm.push(event.playingMs);
      await page.keyboard.press('Escape');
    }
    assert.equal(requests.length, requestsBeforeWarm, 'Prepared word playback needs no second audio download');
    assert.ok(checkedStartOffsets > 0, 'Actual playback must exercise a positive audited leading-silence offset');
    const cold = await clickAndMeasure(page, '#vocab-13');
    assert.equal(cold.source, sourceFor(13));
    assert.ok(cold.playingMs >= delayMs - 100, `A cold source includes the controlled network delay: ${cold.playingMs}`);
    await page.keyboard.press('Escape');
    assert.ok(median(warm) < 150, `Prepared playback median should start within150ms: ${JSON.stringify(warm)}`);
    assert.ok(cold.playingMs > median(warm) + 150, 'Preparation must measurably remove the network wait');
    await page.selectOption('#speed', '0.5');
    const half = await clickAndMeasure(page, '#vocab-0');
    assert.equal(half.rate, .5);
    await blobMatchesSource(page, half);
    await page.keyboard.press('Escape');
    // Hover and pointer-down both target the same source: one preparation fetch
    // is shared, then subsequent playback uses its verified cached bytes.
    const target = sourceFor(12);
    await page.locator('#vocab-12').hover();
    await page.locator('#vocab-12').dispatchEvent('pointerdown');
    await page.waitForTimeout(delayMs + 150);
    const deduplicated = await clickAndMeasure(page, '#vocab-12');
    await blobMatchesSource(page, deduplicated);
    assert.equal(requests.filter(request => request.source === target && request.resourceType === 'fetch').length, 1,
      'Repeated intent shares one preparation request');
    await page.keyboard.press('Escape');
    // Save-data users should not receive any speculative audio downloads.
    const saving = await browser.newPage({viewport: {width: 390, height: 844}});
    await instrument(saving);
    await saving.addInitScript(() => Object.defineProperty(navigator, 'connection', {value: {saveData: true}}));
    const savingRequests = [];
    await serveAudio(saving, savingRequests);
    await saving.goto(baseURL, {waitUntil: 'domcontentloaded'});
    await saving.waitForTimeout(1600);
    assert.equal(savingRequests.length, 0, 'Save-data mode disables speculative fetching');
    await clickAndMeasure(saving, '#vocab-0');
    assert.ok(savingRequests.some(request => request.resourceType === 'media'), 'Save-data mode still allows explicit playback');
    await saving.keyboard.press('Escape');
    // Prefetch failure is deliberately separate from a playable origin response.
    const fallback = await browser.newPage({viewport: {width: 1280, height: 900}});
    await instrument(fallback);
    const fallbackRequests = [];
    await serveAudio(fallback, fallbackRequests, source => source === sourceFor(0));
    await fallback.goto(baseURL, {waitUntil: 'domcontentloaded'});
    await fallback.waitForTimeout(1800);
    assert.ok(fallbackRequests.some(request => request.source === sourceFor(0) && request.resourceType === 'fetch'));
    const recovered = await clickAndMeasure(fallback, '#vocab-0');
    assert.equal(recovered.source, sourceFor(0));
    assert.equal(new URL(recovered.currentSrc).pathname.endsWith(sourceFor(0)), true, 'A failed prefetch falls back to the verified original URL');
    await fallback.keyboard.press('Escape');
    // Even a response claiming to be audio may contain invalid bytes. The
    // retained blob must be discarded and the original recording retried once.
    const corrupted = await browser.newPage({viewport: {width: 1280, height: 900}});
    await instrument(corrupted);
    const corruptedRequests = [];
    await serveAudio(corrupted, corruptedRequests, () => false, source => source === sourceFor(0));
    await corrupted.goto(baseURL, {waitUntil: 'domcontentloaded'});
    await corrupted.waitForTimeout(1800);
    assert.ok(await corrupted.evaluate(bytes => window.__createdAudioBlobs.some(blob => blob.bytes === bytes), Buffer.byteLength('Not a decodable audio recording')),
      'The corrupt audio-typed response must reach the prepared cache to exercise decode fallback');
    const decodedFallback = await clickAndMeasure(corrupted, '#vocab-0');
    assert.equal(decodedFallback.source, sourceFor(0));
    assert.equal(new URL(decodedFallback.currentSrc).pathname.endsWith(sourceFor(0)), true,
      'An undecodable cached blob must retry the original URL');
    assert.equal(corruptedRequests.filter(request => request.source === sourceFor(0) && request.resourceType === 'media').length, 1,
      'A cached decode error must recover with one original-media request');
    await corrupted.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({controlledAudioResponseDelayMs: delayMs, clickToPlayingColdMs: cold.playingMs,
      clickToPlayingPreparedMs: warm, preparedMedianMs: median(warm), audioBytesPreserved: 'SHA-256 matched actual playback blobs',
      boundedCurrentUnitPreparation: 'passed', intentRequestDeduplication: 'passed', auditedLeadingSilenceSeek: 'passed', checkedStartOffsets,
      halfSpeed: 'passed', saveData: 'passed', prefetchFailureFallback: 'passed', cachedDecodeFailureFallback: 'passed', browserErrors: errors,
      measurementScope: 'Controlled local browser regression; playing event, not measured speaker output or user-network latency'}));
  } finally {
    await Promise.all(pages.filter(page => !page.isClosed()).map(page => page.close()));
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
