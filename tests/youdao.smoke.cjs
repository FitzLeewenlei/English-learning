const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const normalize = word => word.toLowerCase().replace(/’/g, "'");
const tokenPattern = /[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const canonicalPath = 'data/course-units1-120.json';
const canonical = readJSON(canonicalPath);
const previous = readJSON('data/course-units1-32.json');
const preservedCoreWords = new Set(Object.values(previous.units).flatMap(unit => unit.vocabulary.map(entry => normalize(entry.word))));
const audit = readJSON('data/youdao-course.json');
const sandbox = {window: {}};
vm.createContext(sandbox);
for (const file of ['content.js', 'dictionary.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
const dictionary = JSON.parse(JSON.stringify(sandbox.window.WORD_DICTIONARY));
const course = JSON.parse(JSON.stringify(sandbox.window.COURSE));
// Match the trusted baseline's JavaScript recursive key-sort followed by
// JSON.stringify. Numeric-looking keys use JavaScript's integer enumeration
// order; a Python sort_keys serializer would produce a different hash.
const sortedValue = value => Array.isArray(value) ? value.map(sortedValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]))
    : value;
const stableJSON = value => JSON.stringify(sortedValue(value));
const baseline = readJSON('data/preserved-units1-32.json');
assert.equal(sha256(fs.readFileSync(path.join(root, baseline.canonicalSource))), baseline.canonicalSourceSha256, 'The original canonical source must retain its trusted hash');
const oldScope = new Set();
for (const unit of Object.values(previous.units)) {
  for (const entry of unit.vocabulary) oldScope.add(normalize(entry.word));
  for (const entry of unit.examples) for (const form of entry.speechText.match(tokenPattern) || []) oldScope.add(normalize(form));
}
assert.equal(oldScope.size, baseline.dictionaryScopeCount);
const oldRows = Object.fromEntries([...oldScope].map(word => {
  assert.ok(dictionary[word], 'Preserved dictionary row missing: ' + word);
  return [word, dictionary[word]];
}));
assert.equal(sha256(Buffer.from(stableJSON(oldRows), 'utf8')), baseline.dictionaryRowsSha256, 'All2182 original dictionary rows and their provenance must remain unchanged');
console.log('Preservation audit: original canonical source and all2182 complete dictionary rows/provenance match their trusted baseline hashes.');
const scope = new Map();
const coreWords = new Set();
for (const [unitNumber, unit] of Object.entries(canonical.units)) {
  const add = (form, core = false) => {
    const word = normalize(form);
    if (!scope.has(word)) scope.set(word, {units: new Set(), vocabularyUnits: new Set(), forms: new Set()});
    const row = scope.get(word);
    row.units.add(Number(unitNumber)); row.forms.add(form);
    if (core) {row.vocabularyUnits.add(Number(unitNumber)); coreWords.add(word);}
  };
  for (const word of unit.vocabulary) add(word.word, true);
  for (const sentence of unit.examples) for (const form of sentence.speechText.match(tokenPattern) || []) add(form);
}
const coreOccurrences = Object.values(canonical.units).reduce((total, unit) => total + unit.vocabulary.length, 0);
assert.equal(Object.keys(canonical.units).length, 120);
assert.equal(coreOccurrences, 1800);
assert.equal(coreWords.size, 1782);
assert.equal(scope.size, 3905);
assert.equal(preservedCoreWords.size, 480);
for (const [number, unit] of Object.entries(previous.units)) assert.deepEqual(canonical.units[number], unit, `Unit ${number}: preserve the original Units1–32 extraction`);
assert.deepEqual(Object.keys(dictionary).sort(), [...scope.keys()].sort(), 'The runtime dictionary must cover precisely the current document scope');
assert.deepEqual(Object.keys(audit.entries).sort(), [...scope.keys()].sort(), 'Every runtime record needs a source-audit record');
assert.equal(audit.scope_count, scope.size);
assert.equal(audit.course_source.sha256, sha256(fs.readFileSync(path.join(root, canonicalPath))));
assert.equal(audit.counts.vocabulary_total, coreWords.size);
assert.equal(audit.counts.vocabulary_occurrences, coreOccurrences);
assert.equal(audit.counts.audio, Object.keys(audit.audio_files).length);
const officialURL = (value, label) => {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', label);
  assert.equal(url.hostname, 'dict.youdao.com', label);
  return url;
};
const sourceStrings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(sourceStrings) : [];
const stringCache = new Map();
const proofDocument = (digest, label) => {
  assert.match(digest, /^[0-9a-f]{64}$/, label);
  const document = audit.source_documents[digest];
  assert.ok(document, `Missing source response projection: ${label}`);
  assert.equal(document.raw_response_sha256, digest, label);
  officialURL(document.url, label);
  assert.ok(Number.isFinite(Date.parse(document.fetched_at_utc)), label);
  return document;
};
const stringsFor = (digest, label) => {
  if (!stringCache.has(digest)) stringCache.set(digest, sourceStrings(proofDocument(digest, label).fields));
  return stringCache.get(digest);
};
const sourceWord = document => (document.fields.ec || document.fields.simple)?.word?.[0];
const normalizeIPA = value => '/' + value.trim().replace(/^\/+|\/+$/g, '') + '/';
function officialSpeechURL(speech, label) {
  assert.equal(typeof speech, 'string', `${label}: UK recording reference`);
  assert.ok(speech, `${label}: UK recording reference`);
  const url = speech.startsWith('https:') ? officialURL(speech, label) : new URL('https://dict.youdao.com/dictvoice?' + (speech.startsWith('audio=') ? speech : 'audio=' + speech));
  assert.equal(url.pathname, '/dictvoice', label);
  assert.equal(url.searchParams.get('type') || '1', '1', `${label}: UK type=1`);
  return url;
}
let completeCount = 0, audioRecords = 0;
const coreAudioWords = new Set();
const newCoreMissingAudio = [];
for (const [word, expected] of scope) {
  const entry = dictionary[word];
  const record = audit.entries[word];
  assert.equal(entry.source.name, '有道词典', word);
  const sourceURL = officialURL(entry.source.url, word);
  assert.equal(normalize(sourceURL.searchParams.get('word')), normalize(record.lookup_query), word);
  assert.equal(entry.source.query, word);
  assert.equal(entry.source.lookup_query, record.lookup_query);
  assert.deepEqual([...record.units].sort((a, b) => a - b), [...expected.units].sort((a, b) => a - b), word);
  assert.deepEqual([...record.vocabulary_units].sort((a, b) => a - b), [...expected.vocabularyUnits].sort((a, b) => a - b), word);
  assert.deepEqual([...record.forms].sort(), [...expected.forms].sort(), word);
  const document = proofDocument(record.source_document_sha256, word);
  const source = sourceWord(document);
  assert.equal(entry.ipa, record.ipa, word);
  assert.deepEqual(entry.senses, record.source_senses, word);
  const missing = ['ipa', 'senses', 'audio'].filter(field => field === 'senses' ? !entry.senses.length : !entry[field]);
  assert.deepEqual(entry.missing, missing, word);
  assert.deepEqual(record.missing, missing, word);
  assert.equal(entry.status, missing.length ? 'unavailable' : 'complete', word);
  assert.equal(record.status, entry.status, word);
  if (!missing.length) completeCount++;
  const posLabels = new Set();
  for (const sense of entry.senses) {
    assert.ok(sense.pos && !posLabels.has(sense.pos), `${word}: duplicate/empty POS`);
    posLabels.add(sense.pos);
    assert.ok(sense.meanings.length >= 1 && sense.meanings.length <= 2, `${word}: at most two glosses per POS`);
    assert.equal(new Set(sense.meanings).size, sense.meanings.length, word);
    const definitions = (record.definition_sources || []).filter(proof => proof.pos === sense.pos);
    const documents = definitions.length ? definitions.map(proof => proof.raw_response_sha256) : [record.source_document_sha256];
    const strings = documents.flatMap(digest => stringsFor(digest, word));
    for (const meaning of sense.meanings) {
      assert.match(meaning, /\p{Script=Han}/u, `${word}: Chinese gloss`);
      assert.ok(strings.some(text => text.includes(meaning)), `${word}: unsourced gloss ${meaning}`);
    }
    assert.ok(strings.some(text => text.includes(sense.pos)), `${word}: unsourced POS ${sense.pos}`);
  }
  for (const proof of record.definition_sources || []) {
    proofDocument(proof.raw_response_sha256, word);
    const form = proofDocument(proof.prototype_proof.raw_response_sha256, word);
    assert.equal(proof.prototype_proof.field, 'ec.word[0].prototype', word);
    assert.equal(form.fields.ec.word[0].prototype, proof.prototype_proof.value, word);
    assert.equal(normalize(proof.prototype_proof.value), normalize(proof.query), word);
  }
  if (entry.ipa) {
    assert.ok(source?.ukphone, `${word}: no source UK IPA`);
    assert.equal(entry.ipa, normalizeIPA(source.ukphone), `${word}: exact source UK IPA, never US/base-form substitution`);
  }
  if (entry.audio) {
    audioRecords++;
    assert.match(entry.audio, /^audio\/youdao-(?:unit1|course)\/[a-zA-Z0-9._-]+\.(?:mp3|wav)$/);
    assert.equal(record.audio, entry.audio, word);
    const provenance = record.audio_source;
    assert.ok(provenance, `${word}: missing per-query audio proof`);
    assert.equal(provenance.type, 1, word);
    assert.equal(provenance.source_field, 'ukspeech', word);
    const url = officialURL(provenance.url, word);
    const reference = officialSpeechURL(source?.ukspeech, word);
    assert.equal(url.pathname, '/dictvoice', word);
    assert.equal(url.searchParams.get('type'), '1', word);
    assert.equal(url.searchParams.get('audio'), reference.searchParams.get('audio'), word);
    assert.equal(normalize(reference.searchParams.get('audio')), normalize(record.lookup_query), word);
    const file = audit.audio_files[entry.audio];
    assert.ok(file, `${word}: missing audio-file proof`);
    assert.equal(provenance.sha256, file.sha256, word);
    assert.equal(provenance.codec, file.codec, word);
  } else {
    assert.ok(entry.missing.includes('audio'), word);
    assert.equal(record.audio, null, word);
  }
  if (preservedCoreWords.has(word)) assert.ok(entry.audio, `${word}: preserve Youdao UK audio for all480 original core words`);
  if (coreWords.has(word)) {
    if (entry.audio) coreAudioWords.add(word);
    else {
      const returnedPhrase = source?.['return-phrase'];
      const returned = typeof returnedPhrase === 'string' ? returnedPhrase : returnedPhrase?.l?.i;
      const mismatch = record.source_form_mismatch;
      const provenDifferentForm = mismatch && mismatch.query === word && typeof returned === 'string'
        && normalize(mismatch.headword) === normalize(returned) && normalize(returned) !== normalize(record.lookup_query)
        && entry.source.definition_scope === 'returned_headword';
      assert.ok(!source?.ukspeech || provenDifferentForm, `${word}: a provided matching-form UK source recording must be acquired, not silently marked missing`);
      assert.ok(entry.missing.includes('audio') && record.missing.includes('audio'), word);
      newCoreMissingAudio.push({word, units: record.vocabulary_units, missing: entry.missing});
    }
  }
}
assert.equal(audit.counts.complete, completeCount);
assert.equal(audit.counts.vocabulary_audio, coreAudioWords.size);
const coreAudioOccurrences = Object.values(canonical.units).flatMap(unit => unit.vocabulary).filter(entry => dictionary[normalize(entry.word)].audio).length;
assert.equal(audit.counts.vocabulary_audio_occurrences, coreAudioOccurrences);
console.log(`Source audit: ${scope.size} entries, ${completeCount} complete; exact UK phonetics, source glosses/POS (maximum2), missing states and ${coreAudioWords.size}/${coreWords.size} distinct core-word audio bindings passed; original480 audio retained.`);
console.log(JSON.stringify({newCoreWordsWithoutSourceUKAudio: newCoreMissingAudio}));

async function verifyAudioFiles() {
  const files = Object.entries(audit.audio_files);
  let next = 0, done = 0;
  const run = promisify(execFile);
  await Promise.all(Array.from({length: Math.min(4, files.length)}, async () => {
    while (next < files.length) {
      const [file, provenance] = files[next++];
      officialURL(provenance.url, file);
      assert.equal(new URL(provenance.url).searchParams.get('type'), '1', file);
      const target = path.join(root, file);
      assert.equal(sha256(fs.readFileSync(target)), provenance.sha256, `${file}: actual audio checksum`);
      const {stdout} = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', target], {maxBuffer: 1024 * 1024});
      const probe = JSON.parse(stdout);
      assert.ok(probe.streams.some(stream => stream.codec_name === provenance.codec), `${file}: source codec`);
      const duration = Number(probe.format.duration);
      assert.ok(duration > 0 && Math.abs(duration - provenance.duration_seconds) < 0.05, `${file}: source duration`);
      if (++done % 250 === 0) console.log(`Audio integrity: ${done}/${files.length} hashes and codecs verified.`);
    }
  }));
  console.log(`Audio integrity: all${files.length} Youdao UK assets hashed and decoded; ${audioRecords} dictionary records bind these files.`);
}

(async () => {
  await verifyAudioFiles();
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.setDefaultTimeout(8000);
    const waitForUnit = number => page.waitForFunction(expected =>
      document.querySelector('#current-list').textContent === `Unit ${expected}`
        && document.querySelector('main').getAttribute('aria-busy') !== 'true', String(number));
    async function selectUnit(number) {
      await page.selectOption('#list-select', String(number));
      await waitForUnit(number);
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);});
    await page.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.Audio = function(...args) {const audio = new NativeAudio(...args); window.__audio = audio; return audio;};
    });
    await page.goto(baseURL, {waitUntil: 'networkidle'});
    await page.selectOption('#speed', '0.5');
    let coreSamples = 0, popupSamples = 0, missingCoreUISamples = 0;
    const checkedForms = new Set();
    const playback = async entry => {
      await page.waitForFunction(() => window.__audio.currentTime > 0 && !window.__audio.paused);
      assert.equal(await page.evaluate(() => window.__audio.currentSrc), new URL(entry.audio, baseURL).href);
      assert.equal(await page.evaluate(() => window.__audio.playbackRate), 0.5);
      assert.equal(await page.locator('#notice').isVisible(), false);
      assert.equal((await page.locator('#player-kind').textContent()).includes('英'), false);
    };
    async function checkPopup(form, play = false) {
      const entry = dictionary[normalize(form.text)];
      assert.ok(entry, form.text);
      await page.locator('#' + form.id).click();
      assert.equal(await page.locator('#word-details').evaluate(node => node.matches(':popover-open')), true, form.text);
      assert.equal(await page.locator('#word-detail-title').textContent(), form.text);
      assert.equal(await page.locator('#word-detail-ipa').textContent(), entry.ipa || '有道音标暂缺');
      assert.deepEqual(await page.locator('#word-detail-definition .word-sense-meaning').allTextContents(), entry.senses.map(sense => sense.meanings.join('；')));
      assert.deepEqual(await page.locator('#word-detail-definition .word-sense-pos').allTextContents(), entry.senses.map(sense => sense.pos));
      if (!entry.senses.length) assert.equal(await page.locator('#word-detail-definition .word-unavailable').textContent(), '有道暂未提供该词形的释义');
      assert.equal(await page.locator('#word-detail-play').isEnabled(), Boolean(entry.audio));
      assert.equal((await page.locator('#word-detail-play').getAttribute('aria-label')).includes('英'), false);
      assert.equal(await page.locator('#word-detail-source').getAttribute('href'), entry.source.url);
      if (play && entry.audio) {await page.locator('#word-detail-play').click(); await playback(entry);}
      await page.locator('#word-detail-close').click();
      checkedForms.add(normalize(form.text)); popupSamples++;
    }
    for (const number of [1, 32, 33, 64, 120]) {
      await selectUnit(String(number));
      const unit = canonical.units[number];
      for (const index of [0, 3, 7, 11, 14]) {
        const documentWord = unit.vocabulary[index];
        const entry = dictionary[normalize(documentWord.word)];
        const card = page.locator('#vocab-' + index);
        assert.equal(await card.locator('.word-ipa').textContent(), documentWord.ipa, 'Section01 IPA must remain document-owned');
        assert.deepEqual(await card.locator('.word-sense-pos').allTextContents(), [documentWord.partsOfSpeech]);
        assert.deepEqual(await card.locator('.word-sense-meaning').allTextContents(), [documentWord.meaning]);
        assert.equal(await card.isEnabled(), Boolean(entry.audio), `${documentWord.word}: recording availability`);
        if (entry.audio) {await card.click(); await playback(entry); await page.keyboard.press('Escape');}
        else missingCoreUISamples++;
        coreSamples++;
      }
      const forms = await page.locator('.word-token').evaluateAll(nodes => [...new Map(nodes.map(node => [node.textContent.toLowerCase().replace(/’/g, "'"), {id: node.id, text: node.textContent}])).values()]);
      const chosen = new Map();
      for (let i = 0; i < 10; i++) {
        const form = forms[Math.floor(i * (forms.length - 1) / 9)]; chosen.set(form.id, form);
      }
      for (const form of [...chosen.values()]) await checkPopup(form, true);
      for (const form of forms.filter(form => dictionary[normalize(form.text)].status === 'unavailable').slice(0, 2)) {
        if (!checkedForms.has(normalize(form.text))) await checkPopup(form);
      }
    }
    // Exercise a genuinely missing source field even if the spread samples have
    // only complete records. The fallback must remain explicit and unsourced.
    const missing = Object.entries(audit.entries).find(([word, entry]) => dictionary[word].status === 'unavailable' && scope.get(word).units.size);
    if (missing && !checkedForms.has(missing[0])) {
      const [word, record] = missing;
      for (const unitNumber of record.units) {
        await selectUnit(String(unitNumber));
        const form = await page.locator('.word-token').evaluateAll((nodes, key) => {
          const node = nodes.find(node => node.textContent.toLowerCase().replace(/’/g, "'") === key);
          return node ? {id: node.id, text: node.textContent} : null;
        }, word);
        if (form) {await checkPopup(form); break;}
      }
    }
    // Every genuinely missing new core recording remains visible as document
    // text, with its play control disabled rather than silently using US/TTS.
    for (const missing of newCoreMissingAudio) {
      const number = missing.units[0];
      await selectUnit(String(number));
      const index = canonical.units[number].vocabulary.findIndex(entry => normalize(entry.word) === missing.word);
      assert.ok(index >= 0, missing.word);
      const card = page.locator('#vocab-' + index);
      assert.equal(await card.isEnabled(), false, `${missing.word}: missing recording must not be disguised`);
      assert.equal(await card.locator('.word-name').textContent(), canonical.units[number].vocabulary[index].word);
      missingCoreUISamples++;
    }
    await selectUnit('120');
    const rich = await page.locator('.word-token').evaluateAll(nodes => {
      const entries = window.WORD_DICTIONARY;
      return [...nodes].sort((a, b) => (entries[b.textContent.toLowerCase().replace(/’/g, "'")]?.senses.length || 0) - (entries[a.textContent.toLowerCase().replace(/’/g, "'")]?.senses.length || 0)).map(node => ({id: node.id, text: node.textContent}))[0];
    });
    for (const [width, height] of [[390, 844], [320, 568]]) {
      await page.setViewportSize({width, height});
      await page.locator('#' + rich.id).click();
      const box = await page.locator('#word-details').boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, JSON.stringify(box));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.keyboard.press('Escape');
    }
    await page.reload({waitUntil: 'networkidle'});
    assert.equal(await page.locator('#speed').inputValue(), '0.5');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({scope: scope.size, coreOccurrences, distinctCoreWords: coreWords.size, preservedCoreYoudaoAudio: preservedCoreWords.size, coreYoudaoAudio: coreAudioWords.size, coreYoudaoAudioOccurrences: coreAudioOccurrences, missingCoreYoudaoAudio: newCoreMissingAudio, missingCoreUISamples, uniqueAudioAssets: Object.keys(audit.audio_files).length, documentOwnedVocabularySamples: coreSamples, youdaoPopupSamples: popupSamples, actualHalfSpeedAudio: 'passed', missingStates: 'passed', mobileWidths: [390, 320], browserErrors: errors}));
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
