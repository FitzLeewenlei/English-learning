(() => {
  'use strict';
  const course = window.COURSE;
  const $ = (id) => document.getElementById(id);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const normalize = (word) => word.toLowerCase().replace(/’/g, "'");
  const tokenPattern = /([A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*)/g;
  const isToken = /^[A-Za-z]+(?:[’'-][A-Za-z]+)*$|^\d+(?:,\d{3})*$/;
  let data, currentList, wordItems = [], exampleItems = [];
  let targetWords = new Set();
  let selectedToken = null, selectedWord = null;

  function readPreference(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function storePreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Controls work without storage. */ }
  }

  function wordEntry(word) {
    const key = normalize(word);
    const dictionary = window.WORD_DICTIONARY || {};
    return Object.hasOwn(dictionary, key) ? dictionary[key] : {ipa: '', senses: [], audio: '', status: 'unavailable'};
  }

  function renderWordMeanings(container, entry) {
    container.replaceChildren();
    const senses = entry.senses || [];
    for (const sense of senses) {
      const row = document.createElement('span');
      row.className = 'word-sense';
      const pos = document.createElement('span');
      pos.className = 'word-sense-pos';
      pos.lang = /[a-z]/i.test(sense.pos) ? 'en' : 'zh-CN';
      pos.textContent = sense.pos;
      const meaning = document.createElement('span');
      meaning.className = 'word-sense-meaning';
      meaning.lang = 'zh-CN';
      meaning.textContent = sense.meanings.slice(0, 2).join('；');
      row.append(pos, meaning);
      container.append(row);
    }
    if (!senses.length) {
      const message = document.createElement('span');
      message.className = 'word-unavailable';
      message.textContent = '有道暂未提供该词形的释义';
      container.append(message);
    }
  }
  const storedSpeed = readPreference('garden-reader-speed', '1');
  $('speed').value = ['0.5', '0.75', '1', '1.25'].includes(storedSpeed) ? storedSpeed : '1';

  function clearWordDetails() {
    selectedToken?.classList.remove('is-selected');
    selectedToken?.setAttribute('aria-expanded', 'false');
    selectedToken = null;
    selectedWord = null;
    if (player.mode === 'word-detail') player.stop();
  }

  function hideWordDetails(restoreFocus = false) {
    const trigger = selectedToken;
    if ($('word-details').matches(':popover-open')) $('word-details').hidePopover();
    clearWordDetails();
    if (restoreFocus) trigger?.focus({preventScroll: true});
  }

  function positionWordDetails() {
    if (!selectedToken || !$('word-details').matches(':popover-open')) return;
    const card = $('word-details');
    const anchor = selectedToken.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > window.innerHeight) {
      hideWordDetails();
      return;
    }
    const gap = 10, margin = 12;
    const left = Math.min(Math.max(margin, anchor.left), window.innerWidth - card.offsetWidth - margin);
    const below = anchor.bottom + gap;
    const top = below + card.offsetHeight <= window.innerHeight - margin
      ? below : Math.max(margin, anchor.top - card.offsetHeight - gap);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function showWordDetails(word, trigger) {
    if (selectedToken === trigger && $('word-details').matches(':popover-open')) {
      hideWordDetails(true);
      return;
    }
    hideWordDetails();
    player.stop();
    trigger.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
    const entry = wordEntry(word);
    selectedToken = trigger;
    selectedWord = {text: word, src: entry.audio, elementId: 'word-detail-play', type: 'word'};
    $('word-detail-title').textContent = word;
    const headword = entry.source?.definition_scope === 'returned_headword'
      ? entry.headword || entry.source.headword
      : entry.lemma || entry.source?.lemma;
    const headwordLabel = $('word-detail-headword');
    headwordLabel.hidden = !headword || normalize(headword) === normalize(word);
    headwordLabel.textContent = headwordLabel.hidden ? '' : `有道词头：${headword}`;
    $('word-detail-ipa').textContent = entry.ipa || '有道音标暂缺';
    renderWordMeanings($('word-detail-definition'), entry);
    $('word-detail-play').disabled = !selectedWord.src;
    $('word-detail-play').setAttribute('aria-label', selectedWord.src ? `播放 ${word} 的发音` : `${word} 的有道发音暂缺`);
    const source = $('word-detail-source');
    const url = entry.source?.url;
    source.hidden = !url || !url.startsWith('https://dict.youdao.com/');
    if (source.hidden) source.removeAttribute('href');
    else source.href = url;
    trigger.classList.add('is-selected');
    trigger.setAttribute('aria-expanded', 'true');
    $('word-details').showPopover({source: trigger});
    positionWordDetails();
    (selectedWord.src ? $('word-detail-play') : $('word-detail-close')).focus({preventScroll: true});
  }

  function createSentence(text, item) {
    const line = document.createElement('p');
    line.className = 'sentence';
    line.id = item.elementId;
    line.lang = 'en';
    let tokenIndex = 0;
    function appendEnglish(fragment) {
      for (const part of fragment.split(tokenPattern)) {
        if (isToken.test(part)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'word-token';
          if (targetWords.has(normalize(part))) button.classList.add('target-word');
          button.id = `${item.elementId}-word-${tokenIndex++}`;
          button.textContent = part;
          button.setAttribute('aria-label', `查看单词 ${part}`);
          button.setAttribute('aria-haspopup', 'dialog');
          button.setAttribute('aria-controls', 'word-details');
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', () => showWordDetails(part, button));
          line.append(button);
        } else {
          line.append(document.createTextNode(part));
        }
      }
    }
    let cursor = 0;
    for (const annotation of item.annotations || []) {
      appendEnglish(text.slice(cursor, annotation.start));
      const note = document.createElement('span');
      note.className = 'sentence-note';
      note.lang = 'zh-CN';
      note.textContent = annotation.text;
      line.append(note);
      cursor = annotation.end;
    }
    appendEnglish(text.slice(cursor));
    const speaker = document.createElement('button');
    speaker.type = 'button';
    speaker.className = 'sentence-play';
    speaker.innerHTML = icon('volume');
    speaker.setAttribute('aria-label', `朗读整句：${item.text}`);
    speaker.setAttribute('aria-pressed', 'false');
    speaker.disabled = !item.src;
    speaker.addEventListener('click', () => player.start([item], 'sentence'));
    line.append(speaker);
    return line;
  }

  function renderList(number) {
    const next = course.lists[number];
    if (!next) { $('list-select').value = String(currentList); return; }
    hideWordDetails();
    player.stop();
    currentList = number;
    data = next;
    $('list-select').value = String(number);
    $('current-list').textContent = `Unit ${number}`;
    $('vocabulary-grid').replaceChildren();
    $('examples-content').replaceChildren();
    targetWords = new Set([...data.vocabulary.map((entry) => normalize(entry.word)), ...(data.targetForms || []), ...data.examples.flatMap((entry) => entry.targetForms || [])]);
    wordItems = data.vocabulary.map((entry, index) => ({text: entry.word, src: wordEntry(entry.word).audio, elementId: `vocab-${index}`, type: 'word'}));
    exampleItems = data.examples.map((entry, index) => ({text: entry.speechText || entry.text, annotations: entry.annotations || [], src: entry.audio, elementId: `example-${index}`, type: 'sentence'}));

    for (const [index, entry] of data.vocabulary.entries()) {
      const details = wordEntry(entry.word);
      const button = document.createElement('button');
      button.className = 'word-card';
      button.id = `vocab-${index}`;
      button.type = 'button';
      button.disabled = !details.audio;
      button.setAttribute('aria-label', `朗读单词 ${entry.word}`);
      const topline = document.createElement('span');
      topline.className = 'word-topline';
      const name = document.createElement('span');
      name.className = 'word-name';
      name.lang = 'en';
      name.textContent = entry.word;
      const sound = document.createElement('span');
      sound.className = 'word-sound';
      sound.innerHTML = icon('volume');
      topline.append(name, sound);
      const ipa = document.createElement('span');
      ipa.className = 'word-ipa';
      ipa.lang = 'en';
      ipa.textContent = entry.ipa;
      const meaning = document.createElement('span');
      meaning.className = 'word-meaning';
      const definition = document.createElement('span');
      definition.className = 'word-sense';
      const pos = document.createElement('span');
      pos.className = 'word-sense-pos';
      pos.textContent = entry.partsOfSpeech;
      const gloss = document.createElement('span');
      gloss.className = 'word-sense-meaning';
      gloss.textContent = entry.meaning;
      definition.append(pos, gloss);
      meaning.append(definition);
      button.append(topline, ipa, meaning);
      button.addEventListener('click', () => player.start([wordItems[index]], 'word'));
      $('vocabulary-grid').append(button);
    }

    for (const [index, entry] of data.examples.entries()) {
      const row = document.createElement('article');
      row.className = 'example-row';
      const number = document.createElement('span');
      number.className = 'example-number';
      number.textContent = String(index + 1).padStart(2, '0');
      number.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      body.className = 'example-body';
      const translation = document.createElement('p');
      translation.className = 'example-translation';
      translation.lang = 'zh-CN';
      translation.textContent = entry.translation;
      body.append(createSentence(entry.text, exampleItems[index]));
      if (entry.source) {
        const source = document.createElement('p');
        source.className = 'example-source';
        source.textContent = entry.source;
        body.append(source);
      }
      body.append(translation);
      row.append(number, body);
      $('examples-content').append(row);
    }

    storePreference('english-reader-list', String(number));
  }

  class SentenceFocus {
    constructor(owner) {
      this.owner = owner;
      this.dialog = $('sentence-focus');
      this.words = [];
      this.frame = null;
      this.activeWord = -1;
      window.addEventListener('resize', () => {
        this.activeWord = -1;
        this.sync();
      });
      $('focus-close').addEventListener('click', () => owner.stop());
      $('focus-toggle').addEventListener('click', () => owner.togglePause());
      $('focus-rewind').addEventListener('click', () => owner.seek(-5));
      $('focus-forward').addEventListener('click', () => owner.seek(5));
      this.dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        owner.stop();
      });
      this.dialog.addEventListener('close', () => {
        if (!this.dialog.open && owner.items[owner.index]?.type === 'sentence') owner.stop();
      });
      const outside = (event) => {
        const bounds = this.dialog.getBoundingClientRect();
        return event.target === this.dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
      };
      let pressedOutside = false;
      this.dialog.addEventListener('pointerdown', (event) => { pressedOutside = outside(event); });
      this.dialog.addEventListener('click', (event) => {
        if (pressedOutside && outside(event)) owner.stop();
        pressedOutside = false;
      });
      this.dialog.addEventListener('keydown', (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          owner.seek(event.key === 'ArrowLeft' ? -5 : 5);
        } else if (event.code === 'Space' && event.target.tagName !== 'BUTTON') {
          event.preventDefault();
          owner.togglePause();
        }
      });
    }
    show(item, index, total) {
      this.cancelFrame();
      this.words = [];
      this.activeWord = -1;
      const sentence = $('focus-sentence');
      sentence.replaceChildren();
      let weight = 0;
      const spokenNumbers = {'10': 'ten', '1988': 'nineteen eighty eight', '200': 'two hundred', '25,000': 'twenty five thousand', 'mwc': 'em double u see'};
      for (const part of item.text.split(tokenPattern)) {
        if (isToken.test(part)) {
          const element = document.createElement('span');
          element.className = 'focus-word';
          element.textContent = part;
          const key = normalize(part);
          const length = Math.max(2, (spokenNumbers[key] || key).length);
          this.words.push({element, key, from: weight, weight: length});
          weight += length;
          sentence.append(element);
        } else {
          sentence.append(document.createTextNode(part));
        }
      }
      this.totalWeight = weight;
      const aligned = window.SENTENCE_TIMINGS?.[item.src]?.words;
      this.timings = aligned?.length === this.words.length && aligned.every((entry, i) =>
        normalize(entry.text) === this.words[i].key && Number.isFinite(entry.start) && entry.end > entry.start
      ) ? aligned : null;
      $('focus-count').textContent = total > 1 ? `${String(index + 1).padStart(2, '0')} / ${total}` : '整句朗读';
      this.dialog.classList.toggle('is-long', item.text.length > 180);
      this.dialog.classList.toggle('is-short', item.text.length < 65);
      sentence.scrollTop = 0;
      document.body.classList.add('sentence-focus-open');
      if (!this.dialog.open) this.dialog.showModal();
      this.sync();
    }
    sync() {
      if (!this.dialog.open) return;
      const audio = this.owner.audio;
      const duration = audio.duration;
      const loaded = Number.isFinite(duration) && duration > 0;
      const time = Math.max(0, audio.currentTime || 0);
      const format = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
      const timeLabel = `${format(time)} / ${loaded ? format(duration) : '--:--'}`;
      if ($('focus-time').textContent !== timeLabel) $('focus-time').textContent = timeLabel;
      const label = audio.paused ? '继续朗读' : '暂停朗读';
      if ($('focus-toggle').getAttribute('aria-label') !== label) {
        $('focus-toggle').innerHTML = icon(audio.paused ? 'play' : 'pause');
        $('focus-toggle').setAttribute('aria-label', label);
      }
      $('focus-rewind').disabled = !loaded;
      $('focus-forward').disabled = !loaded;
      let current = -1;
      for (const [i, word] of this.words.entries()) {
        const start = this.timings ? this.timings[i].start : duration * word.from / this.totalWeight;
        const end = this.timings ? this.timings[i].end : duration * (word.from + word.weight) / this.totalWeight;
        const fraction = loaded ? Math.max(0, Math.min(1, (time - start) / (end - start))) : 0;
        word.element.style.setProperty('--word-progress', `${(fraction * 100).toFixed(2)}%`);
        if (current === -1 && (time < end || !loaded)) current = i;
      }
      if (current === -1) current = this.words.length - 1;
      if (current !== this.activeWord && current >= 0) {
        this.activeWord = current;
        // Scroll only the subtitle pane, leaving the dialog controls in place.
        const pane = $('focus-sentence');
        const bounds = pane.getBoundingClientRect();
        const wordBounds = this.words[current].element.getBoundingClientRect();
        if (wordBounds.top < bounds.top + 8) pane.scrollTop -= bounds.top + 8 - wordBounds.top;
        else if (wordBounds.bottom > bounds.bottom - 8) pane.scrollTop += wordBounds.bottom - bounds.bottom + 8;
      }
    }
    watch() {
      this.cancelFrame();
      const tick = () => {
        this.sync();
        if (this.dialog.open && !this.owner.audio.paused && !this.owner.audio.ended) this.frame = requestAnimationFrame(tick);
      };
      tick();
    }
    cancelFrame() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    hide() {
      this.cancelFrame();
      if (this.dialog.open) this.dialog.close();
      document.body.classList.remove('sentence-focus-open');
      this.words = [];
      this.timings = null;
    }
  }

  class AudioPlayer {
    constructor() {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.playsInline = true;
      this.audio.preservesPitch = true;
      this.items = [];
      this.index = 0;
      this.mode = '';
      this.generation = 0;
      this.activeElement = null;
      this.focus = new SentenceFocus(this);
      this.audio.addEventListener('ended', () => {
        if (!this.items.length) return;
        if (this.index + 1 < this.items.length) {
          this.index++;
          this.playCurrent();
        } else {
          this.stop();
        }
      });
      this.audio.addEventListener('timeupdate', () => {
        const duration = this.audio.duration;
        const fraction = Number.isFinite(duration) && duration > 0 ? this.audio.currentTime / duration : 0;
        const total = this.items.length || 1;
        $('player-progress').style.width = `${Math.min(100, ((this.index + fraction) / total) * 100)}%`;
        this.focus.sync();
      });
      for (const name of ['loadedmetadata', 'durationchange', 'seeking', 'seeked']) {
        this.audio.addEventListener(name, () => this.focus.sync());
      }
      this.audio.addEventListener('play', () => this.focus.watch());
      this.audio.addEventListener('pause', () => {
        this.focus.cancelFrame();
        this.focus.sync();
      });
      this.audio.addEventListener('error', () => {
        if (this.items.length) this.fail();
      });
    }
    start(items, mode) {
      if (mode !== 'word-detail') hideWordDetails();
      this.stop();
      $('notice').hidden = true;
      this.items = items;
      this.mode = mode;
      this.index = 0;
      this.playCurrent();
    }
    playCurrent() {
      this.clearHighlight();
      const item = this.items[this.index];
      if (!item) return this.stop();
      this.focus.cancelFrame();
      this.generation++;
      this.activeElement = $(item.elementId);
      if (this.activeElement) {
        this.activeElement.classList.add(item.type === 'sentence' ? 'is-speaking' : 'is-playing');
        const speaker = item.type === 'sentence' ? this.activeElement.querySelector('.sentence-play') : this.activeElement;
        speaker?.setAttribute('aria-pressed', 'true');
      }
      $('player').hidden = item.type === 'sentence';
      $('player-kind').textContent = item.type === 'word' ? '单词朗读' : '句子朗读';
      $('player-text').textContent = item.text;
      $('player-count').textContent = this.items.length > 1 ? `${String(this.index + 1).padStart(2, '0')} / ${this.items.length}` : '';
      $('screen-reader-status').textContent = `正在朗读：${item.text}`;
      this.updateButtons();
      if (!item.src) return this.fail();
      this.audio.src = item.src;
      this.audio.playbackRate = Number($('speed').value);
      if (item.type === 'sentence') this.focus.show(item, this.index, this.items.length);
      else this.focus.hide();
      this.resume();
    }
    resume() {
      const generation = this.generation;
      try {
        const started = this.audio.play();
        started?.catch((error) => {
          if (generation !== this.generation || error.name === 'AbortError') return;
          this.fail();
        });
      } catch { this.fail(); }
    }
    togglePause() {
      if (this.items[this.index]?.type !== 'sentence') return;
      if (this.audio.paused) this.resume();
      else this.audio.pause();
      this.focus.sync();
    }
    seek(seconds) {
      const duration = this.audio.duration;
      if (this.items[this.index]?.type !== 'sentence' || !Number.isFinite(duration) || duration <= 0) return;
      this.audio.currentTime = Math.max(0, Math.min(duration, this.audio.currentTime + seconds));
      this.focus.sync();
    }
    clearHighlight() {
      if (this.activeElement) {
        this.activeElement.classList.remove('is-playing', 'is-speaking');
        this.activeElement.removeAttribute('aria-pressed');
        this.activeElement.querySelector('.sentence-play')?.removeAttribute('aria-pressed');
        this.activeElement = null;
      }
    }
    updateButtons() {
      for (const [mode, id, label] of [
        ['vocabulary', 'play-vocabulary', '依次朗读'],
        ['examples', 'play-examples', '依次朗读']
      ]) {
        const active = this.mode === mode && this.items.length > 0;
        $(id).innerHTML = icon(active ? 'stop' : 'play') + `<span>${active ? '停止朗读' : label}</span>`;
        $(id).setAttribute('aria-pressed', String(active));
      }
    }
    stop() {
      const restoreTo = this.focus.dialog.open ? this.activeElement?.querySelector('.sentence-play') : null;
      this.generation++;
      this.items = [];
      this.index = 0;
      this.mode = '';
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.focus.hide();
      this.clearHighlight();
      $('player').hidden = true;
      $('player-progress').style.width = '0%';
      $('screen-reader-status').textContent = '';
      this.updateButtons();
      restoreTo?.focus({preventScroll: true});
    }
    fail() {
      this.stop();
      $('notice').textContent = '暂时未能播放，请检查网络后再点一次。';
      $('notice').hidden = false;
      clearTimeout(this.noticeTimeout);
      this.noticeTimeout = setTimeout(() => { $('notice').hidden = true; }, 4500);
    }
  }

  const player = new AudioPlayer();
  for (let number = 1; number <= course.totalLists; number++) {
    const option = document.createElement('option');
    option.value = String(number);
    option.disabled = !course.lists[number];
    option.textContent = `Unit ${number}${option.disabled ? ' · 待添加' : ''}`;
    $('list-select').append(option);
  }
  const available = Object.keys(course.lists).map(Number).sort((a, b) => a - b);
  const storedList = Number(readPreference('english-reader-list', '1'));
  renderList(course.lists[storedList] ? storedList : available[0]);
  $('list-select').addEventListener('change', () => {
    renderList(Number($('list-select').value));
    window.scrollTo({top: 0, behavior: 'instant'});
  });
  for (const [mode, id, getItems] of [
    ['vocabulary', 'play-vocabulary', () => wordItems],
    ['examples', 'play-examples', () => exampleItems]
  ]) {
    $(id).addEventListener('click', () => {
      if (player.mode === mode) player.stop();
      else player.start(getItems(), mode);
    });
  }
  $('stop-reading').addEventListener('click', () => player.stop());
  $('speed').addEventListener('change', () => {
    player.audio.playbackRate = Number($('speed').value);
    storePreference('garden-reader-speed', $('speed').value);
  });
  $('word-detail-play').addEventListener('click', () => {
    if (selectedWord) player.start([selectedWord], 'word-detail');
  });
  $('word-detail-close').addEventListener('click', () => hideWordDetails(true));
  $('word-details').addEventListener('beforetoggle', (event) => {
    if (event.newState === 'closed') clearWordDetails();
  });
  window.addEventListener('resize', positionWordDetails);
  window.addEventListener('scroll', positionWordDetails, {passive: true});
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideWordDetails(true);
      player.stop();
    }
  });
  window.addEventListener('pagehide', () => {
    hideWordDetails();
    player.stop();
  });
})();
