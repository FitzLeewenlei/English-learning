const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const sandbox = {window: {}};
vm.createContext(sandbox);
for (const file of ['content.js', 'dictionary.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
const dictionary = JSON.parse(JSON.stringify(sandbox.window.WORD_DICTIONARY));
const unit = JSON.parse(JSON.stringify(sandbox.window.COURSE.lists[1]));
const audit = JSON.parse(fs.readFileSync(path.join(root, 'data/youdao-unit1.json'), 'utf8'));
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const tokens = /[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
const scope = new Set([...unit.vocabulary.map(e => normalize(e.word)), ...unit.examples.flatMap(e => e.text.match(tokens).map(normalize))]);
const sourceStrings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(sourceStrings) : [];
let audioCount = 0;
for (const word of scope) {
  const entry = dictionary[word];
  assert.ok(entry, `Missing dictionary entry: ${word}`);
  assert.equal(entry.source.name, '有道词典');
  assert.equal(new URL(entry.source.url).hostname, 'dict.youdao.com');
  const document = audit.source_documents[entry.source.raw_response_sha256];
  assert.ok(document, `Missing source proof: ${word}`);
  assert.equal(document.raw_response_sha256, entry.source.raw_response_sha256);
  assert.deepEqual(entry.senses, audit.entries[word].source_senses);
  for (const sense of entry.senses) {
    assert.ok(sense.meanings.length >= 1 && sense.meanings.length <= 3, word);
    const additional = (entry.definition_sources || []).filter(d => d.pos === sense.pos);
    const docs = additional.length ? additional.map(d => audit.source_documents[d.raw_response_sha256]) : [document];
    const strings = docs.flatMap(d => sourceStrings(d.fields));
    for (const meaning of sense.meanings) assert.ok(strings.some(s => s.includes(meaning)), `${word}: unsourced meaning ${meaning}`);
  }
  if (entry.ipa) {
    const ukPhones = [...(document.fields.ec?.word || []), ...(document.fields.simple?.word || [])].map(w => w.ukphone).filter(Boolean);
    assert.ok(ukPhones.some(p => `/${p.trim().replace(/^\/+|\/+$/g, '')}/` === entry.ipa), `${word}: not source UK IPA`);
  }
  if (entry.audio) {
    audioCount++;
    const provenance = audit.audio_files[entry.audio];
    assert.ok(provenance, word);
    const source = new URL(provenance.url);
    assert.equal(source.hostname, 'dict.youdao.com');
    assert.equal(source.searchParams.get('type'), '1');
    assert.equal(entry.source.audio.accent, 'British');
    assert.equal(entry.source.audio.source_field, 'ukspeech');
    assert.ok(entry.audio.startsWith('audio/youdao-unit1/'));
    const audio = fs.readFileSync(path.join(root, entry.audio));
    assert.equal(createHash('sha256').update(audio).digest('hex'), provenance.sha256);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', path.join(root, entry.audio)], {encoding: 'utf8'}));
    assert.ok(Number(probe.format.duration) > 0, word);
    assert.ok(probe.streams.some(s => s.codec_name === provenance.codec), word);
  } else assert.ok(entry.missing.includes('audio'), word);
}
assert.equal(scope.size, 200);
assert.equal(audioCount, 188);
for (const entry of unit.vocabulary) assert.equal(dictionary[normalize(entry.word)].status, 'complete', entry.word);
assert.ok(dictionary.tie.senses.some(s => s.meanings.some(m => m.includes('平局'))));
assert.ok(dictionary.striking.definition_sources.some(s => s.query === 'strike' && s.prototype_proof.value === 'strike'));
console.log('Source audit: 200 entries, 188 British recordings, all15 core words; exact source glosses/UKIPA, hashes and decodes passed.');
(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => {if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);});
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = function(...args) {const audio = new NativeAudio(...args); window.__audio = audio; return audio;};
    });
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/', {waitUntil: 'networkidle'});
    for (const [i, word] of unit.vocabulary.entries()) {
      const entry = dictionary[normalize(word.word)];
      const card = page.locator('#vocab-' + i);
      assert.equal(await card.locator('.word-ipa').textContent(), `英 ${entry.ipa}`);
      assert.deepEqual(await card.locator('.word-sense-meaning').allTextContents(), entry.senses.map(s => s.meanings.join('；')));
    }
    const forms = await page.locator('.word-token').evaluateAll(nodes => [...new Map(nodes.map(n => [n.textContent.toLowerCase().replace(/’/g, "'"), {id: n.id, text: n.textContent}])).values()]);
    for (const form of forms) {
      const entry = dictionary[normalize(form.text)];
      await page.locator('#' + form.id).click();
      assert.equal(await page.locator('#word-details').evaluate(n => n.matches(':popover-open')), true, form.text);
      assert.equal(await page.locator('#word-detail-title').textContent(), form.text);
      assert.deepEqual(await page.locator('#word-detail-definition .word-sense-meaning').allTextContents(), entry.senses.map(s => s.meanings.join('；')));
      assert.equal(await page.locator('#word-detail-ipa').textContent(), entry.ipa ? `英 ${entry.ipa}` : '有道英式音标暂缺');
      assert.equal(await page.locator('#word-detail-play').isEnabled(), Boolean(entry.audio));
      assert.equal(await page.locator('#word-detail-source').getAttribute('href'), entry.source.url);
      await page.locator('#word-detail-close').click();
    }
    console.log('UI audit: all195 sentence forms and all15 vocabulary cards render the source fields and missing states.');
    await page.selectOption('#speed', '0.5');
    for (const word of ['victim', 'comparison', 'striking', '10']) {
      const form = forms.find(f => normalize(f.text) === word) || {id: 'vocab-0'};
      if (word === 'victim') await page.locator('#vocab-0').click();
      else {await page.locator('#' + form.id).click(); await page.locator('#word-detail-play').click();}
      await page.waitForFunction(() => window.__audio.currentTime > 0 && !window.__audio.paused);
      assert.equal(await page.evaluate(() => window.__audio.playbackRate), 0.5);
      assert.ok(await page.evaluate(() => window.__audio.currentSrc.includes('/audio/youdao-unit1/')));
      assert.equal(await page.locator('#notice').isVisible(), false);
      await page.keyboard.press('Escape');
    }
    await page.locator('#play-vocabulary').click();
    await page.waitForFunction(() => document.getElementById('player-count').textContent === '02 / 15');
    assert.ok(await page.evaluate(() => window.__audio.currentSrc.includes('/audio/youdao-unit1/')));
    await page.keyboard.press('Escape');
    const richForm = [...forms].sort((a, b) => dictionary[normalize(b.text)].senses.length - dictionary[normalize(a.text)].senses.length)[0];
    for (const [width, height] of [[390,844],[320,568]]) {
      await page.setViewportSize({width, height});
      await page.locator('#' + richForm.id).click();
      const box = await page.locator('#word-details').boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, JSON.stringify(box));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: `/tmp/youdao-card-${width}.png`});
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({vocabulary:15,exampleForms:forms.length,source:'Youdao',UKRecordings:audioCount,missingUK:200-audioCount,MP3AndWAVPlayback:'passed',halfSpeed:'passed',sequentialWords:'passed',mobile:'passed',browserErrors:errors}));
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exit(1);});
