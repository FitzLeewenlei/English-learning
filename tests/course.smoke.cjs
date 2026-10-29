const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const course = JSON.parse(fs.readFileSync(path.join(root, 'data/course-units1-32.json'), 'utf8'));
const media = JSON.parse(fs.readFileSync(path.join(root, 'audio/course-examples/manifest.json'), 'utf8'));
const tokens = /[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'english-course-'));

// The canonical extraction retains source paragraphs and exact document fields.
assert.equal(course.counts.units, 32);
assert.equal(course.counts.vocabulary, 480);
assert.equal(course.counts.examples, 480);
assert.match(course.source.sha256, /^[0-9a-f]{64}$/);
assert.deepEqual(Object.keys(course.units).map(Number), Array.from({length: 32}, (_, i) => i + 1));
const sandbox = {window: {}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), sandbox);
const saved = JSON.parse(JSON.stringify(sandbox.window.COURSE));
assert.equal(saved.totalLists, 120);
assert.deepEqual(Object.keys(saved.lists).map(Number), Array.from({length: 32}, (_, i) => i + 1));
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
assert.equal(verifiedWords, 480);
assert.equal(verifiedExamples, 480);
console.log('Data parity: all32 units, 480 document words and 480 example/translation/citation pairs; all480 audio checksums and timing bindings passed.');

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
      assert.equal(option.text, `Unit ${i + 1}${i >= 32 ? ' · 待添加' : ''}`);
      assert.equal(option.disabled, i >= 32);
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
    assert.equal(renderedWords, 480);
    assert.equal(renderedExamples, 480);
    console.log('Browser parity: all120 options and every displayed word/example in Unit1–32 matched the document extraction.');

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

    // Sentence playback uses the document's cleaned English, with teaching notes
    // and exam references left visible on the normal page rather than spoken.
    await page.selectOption('#list-select', '1');
    await page.locator('.sentence-play').first().click();
    await playing();
    assert.equal(await page.locator('#focus-sentence').textContent(), course.units['1'].examples[0].speechText);
    await page.keyboard.press('Escape');
    await page.locator('#play-examples').click();
    await playing();
    assert.equal(await page.locator('#focus-count').textContent(), '01 / 15');
    await page.evaluate(() => {window.__audio.currentTime = window.__audio.duration - 0.15;});
    await page.waitForFunction(() => document.getElementById('focus-count').textContent === '02 / 15', null, {timeout: 12000});
    assert.equal(await page.locator('#focus-sentence').textContent(), course.units['1'].examples[1].speechText);
    await page.keyboard.press('Escape');

    await page.selectOption('#list-select', '32');
    await page.locator('.sentence-play').nth(13).click();
    await playing();
    const sample = course.units['32'].examples[13];
    const clip = media.units['32'][13];
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
    assert.ok(clip.duration > 5.5, 'The fixed Unit32 control sample must leave room for a five-second seek');
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
    await page.selectOption('#list-select', '32');
    await page.setViewportSize({width: 320, height: 844});
    await page.screenshot({path: path.join(screenshots, 'unit32-mobile.png')});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.reload({waitUntil: 'networkidle'});
    assert.equal(await page.locator('#list-select').inputValue(), '32');
    assert.equal(await page.locator('#speed').inputValue(), '0.5');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({units: 32, menuOptions: 120, documentWords: renderedWords, documentExamples: renderedExamples,
      topVocabulary: 'document text + Youdao pronunciation', examplePopovers: 'Youdao fields, up to two meanings per POS',
      pronunciationLabels: 'no 英 label', actualAudio: 'passed', sequentialExamples: 'passed', halfSpeedPauseSeek: 'passed',
      mobileWidths: [390,320], browserErrors: errors, screenshots}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
