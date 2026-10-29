const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const course = JSON.parse(fs.readFileSync(path.join(root, 'data/course-units1-120.json'), 'utf8'));
const original32 = JSON.parse(fs.readFileSync(path.join(root, 'data/course-units1-32.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/preserved-units1-32.json'), 'utf8'));
const media = JSON.parse(fs.readFileSync(path.join(root, 'audio/course-examples/manifest.json'), 'utf8'));
const tokens = /[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'english-course-'));
const unitNumbers = Array.from({length: 120}, (_, i) => i + 1);
const originalNumbers = Array.from({length: 32}, (_, i) => i + 1);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)])) : value;
const fingerprint = value => sha256(JSON.stringify(stable(value)));

// Trusted pre-extension fingerprints remain usable in a later shallow checkout,
// without querying Git history or making a network request during the tests.
assert.equal(baseline.keepThrough, 32);
assert.equal(sha256(fs.readFileSync(path.join(root, baseline.canonicalSource))), baseline.canonicalSourceSha256,
  'The original Unit 1–32 canonical source file must stay byte-for-byte unchanged');

// The canonical extraction retains source paragraphs and exact document fields.
assert.equal(course.counts.units, 120);
assert.equal(course.counts.vocabulary, 1800);
assert.equal(course.counts.examples, 1800);
assert.deepEqual(Object.keys(course.units).map(Number), unitNumbers);
assert.equal(course.source.documents.length, 2);
for (const document of course.source.documents) assert.match(document.sha256, /^[0-9a-f]{64}$/);
const documents = new Map(course.source.documents.map(document => [document.id, document]));
for (const number of unitNumbers) {
  const document = documents.get(course.source.unitDocuments[number]);
  assert.ok(document, `Unit ${number}: source document`);
  assert.ok(number >= document.unitRange[0] && number <= document.unitRange[1], `Unit ${number}: source range`);
}
for (const number of originalNumbers) {
  assert.deepEqual(course.units[number], original32.units[number], `Unit ${number}: original canonical data must stay unchanged`);
  assert.equal(documents.get(course.source.unitDocuments[number]).sha256, original32.source.sha256);
}
const originalMedia = Object.fromEntries(originalNumbers.map(number => [number, media.units[number]]));
assert.equal(fingerprint(originalMedia), baseline.mediaUnitsSha256, 'Existing Unit 1–32 audio paths, hashes and word timings must stay unchanged');
const sandbox = {window: {}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), sandbox);
const saved = JSON.parse(JSON.stringify(sandbox.window.COURSE));
assert.equal(saved.totalLists, 120);
assert.deepEqual(Object.keys(saved.lists).map(Number), unitNumbers);
assert.equal(fingerprint(Object.fromEntries(originalNumbers.map(number => [number, saved.lists[number]]))), baseline.runtimeUnitsSha256,
  'Existing Unit 1–32 runtime vocabulary, examples and media bindings must stay unchanged');
let verifiedWords = 0, verifiedExamples = 0;
for (const [number, expected] of Object.entries(course.units)) {
  const unit = saved.lists[number];
  assert.equal(unit.vocabulary.length, 15, `Unit ${number}: word count`);
  assert.equal(unit.examples.length, 15, `Unit ${number}: example count`);
  for (const [i, entry] of expected.vocabulary.entries()) {
    for (const field of ['word', 'ipa', 'partsOfSpeech', 'meaning']) {
      assert.equal(unit.vocabulary[i][field], entry[field], `Unit ${number} word ${i + 1}: ${field}`);
    }
    verifiedWords++;
  }
  assert.equal(media.units[number]?.length, 15, `Unit ${number}: media count`);
  for (const [i, entry] of expected.examples.entries()) {
    for (const field of ['text', 'translation', 'source', 'speechText']) {
      assert.equal(unit.examples[i][field], entry[field], `Unit ${number} example ${i + 1}: ${field}`);
    }
    const clip = media.units[number][i];
    assert.equal(clip.speechText, entry.speechText, `Unit ${number} example ${i + 1}: spoken content`);
    assert.equal(unit.examples[i].audio, clip.audio, `Unit ${number} example ${i + 1}: recording binding`);
    assert.ok(Number(clip.duration) > 0, `Unit ${number} example ${i + 1}: duration`);
    assert.equal(sha256(fs.readFileSync(path.join(root, clip.audio))), clip.sha256, `Unit ${number} example ${i + 1}: audio checksum`);
    assert.deepEqual(clip.words.map(w => w.text), entry.speechText.match(tokens), `Unit ${number} example ${i + 1}: timed tokens`);
    for (const [j, word] of clip.words.entries()) {
      assert.ok(word.start >= 0 && word.end > word.start && word.end <= clip.duration + 0.12, `Unit ${number} example ${i + 1}: word boundary`);
      if (j) assert.ok(word.start >= clip.words[j - 1].end - 0.025, `Unit ${number} example ${i + 1}: timing order`);
    }
    verifiedExamples++;
  }
}
assert.equal(verifiedWords, 1800);
assert.equal(verifiedExamples, 1800);
const uniqueVocabulary = new Set(Object.values(course.units).flatMap(unit => unit.vocabulary.map(entry => entry.word)));
assert.equal(verifiedWords - uniqueVocabulary.size, 18, 'Repeated document vocabulary occurrences must not be deduplicated');
console.log('Data parity: all120 units, 1800 document words and 1800 example/translation/citation pairs; all1800 audio checksums and timing bindings passed. Original32 units and media fingerprints remain unchanged;18 repeated word occurrences retained.');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);});
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = function(...args) {
        const audio = new NativeAudio(...args);
        window.__audio = audio;
        return audio;
      };
    });
    await page.goto(baseURL, {waitUntil: 'networkidle'});
    const options = await page.locator('#list-select option').evaluateAll(nodes => nodes.map(o => ({value: o.value, text: o.textContent, disabled: o.disabled})));
    assert.equal(options.length, 120);
    for (const [i, option] of options.entries()) {
      assert.equal(option.value, String(i + 1));
      assert.equal(option.text, `Unit ${i + 1}`);
      assert.equal(option.disabled, false);
    }
    let renderedWords = 0, renderedExamples = 0;
    for (const [number, expected] of Object.entries(course.units)) {
      await page.selectOption('#list-select', number);
      assert.equal(await page.locator('#current-list').textContent(), `Unit ${number}`);
      const rendered = await page.evaluate(() => ({
        vocabulary: [...document.querySelectorAll('.word-card')].map(card => ({
          word: card.querySelector('.word-name')?.textContent,
          ipa: card.querySelector('.word-ipa')?.textContent,
          partsOfSpeech: card.querySelector('.word-sense-pos')?.textContent,
          meaning: card.querySelector('.word-sense-meaning')?.textContent,
        })),
        examples: [...document.querySelectorAll('.example-row')].map(row => ({
          text: row.querySelector('.sentence')?.textContent,
          translation: row.querySelector('.example-translation')?.textContent,
          source: row.querySelector('.example-source')?.textContent,
        })),
      }));
      assert.deepEqual(rendered.vocabulary, expected.vocabulary.map(({word, ipa, partsOfSpeech, meaning}) => ({word, ipa, partsOfSpeech, meaning})), `Unit ${number}: all document vocabulary facts`);
      assert.deepEqual(rendered.examples, expected.examples.map(({text, translation, source}) => ({text, translation, source})), `Unit ${number}: all document examples/translations/exam references`);
      renderedWords += rendered.vocabulary.length;
      renderedExamples += rendered.examples.length;
    }
    assert.equal(renderedWords, 1800);
    assert.equal(renderedExamples, 1800);
    console.log('Browser parity: all120 enabled options and every displayed word/example in Unit1–120 matched the document extraction.');

    const dictionary = await page.evaluate(() => window.WORD_DICTIONARY);
    const playing = () => page.waitForFunction(() => window.__audio.currentTime > 0 && !window.__audio.paused);
    const audioMatches = async entry => {
      assert.ok(entry?.audio, 'Expected a verified Youdao audio record for the sample word');
      assert.equal(await page.evaluate(() => window.__audio.currentSrc), new URL(entry.audio, baseURL).href);
      assert.equal(await page.evaluate(() => window.__audio.playbackRate), 0.5);
      assert.equal(await page.locator('#notice').isVisible(), false);
      assert.equal(/英/.test(await page.locator('#player-kind').textContent()), false);
    };
    async function checkWordSource(number, word) {
      await page.selectOption('#list-select', String(number));
      await page.selectOption('#speed', '0.5');
      const entry = dictionary[normalize(word)];
      const index = course.units[number].vocabulary.findIndex(v => normalize(v.word) === normalize(word));
      assert.ok(index >= 0);
      await page.locator('#vocab-' + index).click();
      await playing();
      await audioMatches(entry);
      await page.keyboard.press('Escape');
      const tokenId = await page.locator('.word-token').evaluateAll((nodes, query) => nodes.find(n => n.textContent.toLowerCase().replace(/’/g, "'") === query)?.id, normalize(word));
      assert.ok(tokenId, `Unit ${number}: example token ${word}`);
      await page.locator('#' + tokenId).click();
      assert.equal(await page.locator('#word-details').evaluate(node => node.matches(':popover-open')), true);
      const phonetic = await page.locator('#word-detail-ipa').textContent();
      assert.equal(phonetic, entry.ipa);
      assert.equal(phonetic.includes('英'), false);
      assert.equal(await page.locator('#word-detail-play span').textContent(), '发音');
      assert.equal((await page.locator('#word-detail-play').getAttribute('aria-label')).includes('英'), false);
      const definitions = await page.locator('#word-detail-definition .word-sense-meaning').allTextContents();
      assert.deepEqual(definitions, entry.senses.map(sense => sense.meanings.slice(0, 2).join('；')));
      assert.ok(definitions.length > 0);
      assert.equal(new URL(await page.locator('#word-detail-source').getAttribute('href')).hostname, 'dict.youdao.com');
      await page.locator('#word-detail-play').click();
      await playing();
      await audioMatches(entry);
      await page.keyboard.press('Escape');
    }
    await checkWordSource(1, 'best');
    await checkWordSource(32, 'rubber');
    await checkWordSource(33, 'with');
    await checkWordSource(120, 'evidence');

    // Sentence playback uses the document's cleaned English, with teaching notes
    // and exam references left visible on the normal page rather than spoken.
    for (const [number, index] of [[1,0], [32,13], [33,0], [120,0]]) {
      await page.selectOption('#list-select', String(number));
      await page.locator('.sentence-play').nth(index).click();
      await playing();
      assert.equal(await page.locator('#focus-sentence').textContent(), course.units[number].examples[index].speechText);
      assert.equal(await page.locator('.focus-word').count(), media.units[number][index].words.length);
      assert.equal(await page.evaluate(() => window.__audio.currentSrc), new URL(media.units[number][index].audio, baseURL).href);
      await page.keyboard.press('Escape');
    }
    await page.selectOption('#list-select', '33');
    await page.locator('#play-examples').click();
    await playing();
    assert.equal(await page.locator('#focus-count').textContent(), '01 / 15');
    await page.evaluate(() => {window.__audio.currentTime = window.__audio.duration - 0.15;});
    await page.waitForFunction(() => document.getElementById('focus-count').textContent === '02 / 15', null, {timeout: 12000});
    assert.equal(await page.locator('#focus-sentence').textContent(), course.units['33'].examples[1].speechText);
    await page.keyboard.press('Escape');

    await page.selectOption('#list-select', '120');
    await page.locator('.sentence-play').nth(1).click();
    await playing();
    const sample = course.units['120'].examples[1];
    const clip = media.units['120'][1];
    assert.equal(await page.locator('#focus-sentence').textContent(), sample.speechText);
    assert.equal(await page.locator('.focus-word').count(), clip.words.length);
    await page.locator('#focus-toggle').click();
    await page.waitForFunction(() => window.__audio.paused);
    const middle = Math.floor(clip.words.length / 2);
    const word = clip.words[middle];
    const time = (word.start + word.end) / 2;
    await page.evaluate(t => {window.__audio.currentTime = t;}, time);
    await page.waitForFunction(t => !window.__audio.seeking && Math.abs(window.__audio.currentTime - t) < 0.06, time);
    const progress = await page.locator('.focus-word').nth(middle).evaluate(node => parseFloat(node.style.getPropertyValue('--word-progress')));
    assert.ok(Math.abs(progress - 50) < 2, `Aligned middle word progress: ${progress}`);
    const frozenTime = await page.evaluate(() => window.__audio.currentTime);
    await page.waitForTimeout(250);
    assert.ok(Math.abs(await page.evaluate(() => window.__audio.currentTime) - frozenTime) < 0.03);
    assert.ok(clip.duration > 5.5, 'The fixed Unit120 control sample must leave room for a five-second seek');
    await page.evaluate(() => {window.__audio.currentTime = 0;});
    await page.waitForFunction(() => !window.__audio.seeking && window.__audio.currentTime === 0);
    const forwardTarget = 5;
    await page.locator('#focus-forward').click();
    assert.ok(Math.abs(await page.evaluate(() => window.__audio.currentTime) - forwardTarget) < 0.15);
    const backwardTarget = Math.max(0, forwardTarget - 5);
    await page.locator('#focus-rewind').click();
    assert.ok(Math.abs(await page.evaluate(() => window.__audio.currentTime) - backwardTarget) < 0.15);
    for (const [width, height] of [[390,844],[320,568]]) {
      await page.setViewportSize({width, height});
      for (const id of ['focus-toggle', 'focus-rewind', 'focus-forward', 'focus-close']) {
        const bounds = await page.locator('#' + id).boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, `${id}: ${JSON.stringify(bounds)}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: path.join(screenshots, `focus-${width}.png`)});
    }
    await page.keyboard.press('Escape');
    const longest = Object.entries(course.units).flatMap(([number, unit]) => unit.vocabulary.map(entry => ({number, word: entry.word}))).sort((a, b) => b.word.length - a.word.length)[0];
    await page.selectOption('#list-select', longest.number);
    for (const width of [320,390]) {
      await page.setViewportSize({width, height: 844});
      const names = await page.locator('.word-card').evaluateAll(cards => cards.map(card => {
        const name = card.querySelector('.word-name');
        const bounds = name.getBoundingClientRect();
        const outer = card.getBoundingClientRect();
        const style = getComputedStyle(name);
        return {text: name.textContent, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          cardLeft: outer.left, cardRight: outer.right, cardTop: outer.top, cardBottom: outer.bottom,
          scrollWidth: name.scrollWidth, clientWidth: name.clientWidth, textOverflow: style.textOverflow};
      }));
      assert.ok(names.some(name => name.text === longest.word));
      for (const name of names) {
        assert.ok(name.left >= name.cardLeft && name.right <= name.cardRight + 1 && name.top >= name.cardTop && name.bottom <= name.cardBottom + 1, `${width}px clipped word: ${JSON.stringify(name)}`);
        assert.ok(name.scrollWidth <= name.clientWidth + 1, `${width}px text overflow: ${JSON.stringify(name)}`);
        assert.notEqual(name.textOverflow, 'ellipsis', `${width}px truncated word: ${name.text}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: path.join(screenshots, `long-words-${width}.png`)});
    }
    await page.selectOption('#list-select', '120');
    await page.setViewportSize({width: 320, height: 844});
    await page.screenshot({path: path.join(screenshots, 'unit120-mobile.png')});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload({waitUntil: 'networkidle'});
    assert.equal(await page.locator('#list-select').inputValue(), '120');
    assert.equal(await page.locator('#speed').inputValue(), '0.5');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({units: 120, enabledMenuOptions: 120, preservedOriginalUnits: 32, repeatedVocabularyOccurrences: 18,
      documentWords: renderedWords, documentExamples: renderedExamples, playbackSampleUnits: [1,32,33,120],
      topVocabulary: 'document text + Youdao pronunciation', examplePopovers: 'Youdao fields, up to two meanings per POS',
      pronunciationLabels: 'no 英 label', actualAudio: 'passed', sequentialExamples: 'passed', halfSpeedPauseSeek: 'passed',
      mobileWidths: [390,320], browserErrors: errors, screenshots}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
