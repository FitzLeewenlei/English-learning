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
    const key = normalize(word);
    const dictionary = window.WORD_DICTIONARY || {};
    const vocabularyEntry = data.vocabulary.find((entry) => normalize(entry.word) === key);
    const meaningParts = vocabularyEntry?.meaning.match(/^(\S+)\s+(.+)$/);
    const entry = Object.hasOwn(dictionary, key) ? dictionary[key] : {
      ipa: vocabularyEntry?.ipa || '',
      pos: meaningParts?.[1] || '',
      meaning: meaningParts?.[2] || '暂未收录该词的释义。'
    };
    selectedToken = trigger;
    selectedWord = {text: word, src: data.audio.words[key], elementId: 'word-detail-play', type: 'word'};
    $('word-detail-title').textContent = word;
    $('word-detail-ipa').textContent = entry.ipa;
    $('word-detail-pos').textContent = entry.pos;
    $('word-detail-meaning').textContent = entry.meaning;
    $('word-detail-play').disabled = !selectedWord.src;
    $('word-detail-play').setAttribute('aria-label', `播放 ${word} 的发音`);
    trigger.classList.add('is-selected');
    trigger.setAttribute('aria-expanded', 'true');
    $('word-details').showPopover({source: trigger});
    positionWordDetails();
    $('word-detail-play').focus({preventScroll: true});
  }

  function createSentence(text, item) {
    const line = document.createElement('p');
    line.className = 'sentence';
    line.id = item.elementId;
    line.lang = 'en';
    let tokenIndex = 0;
    for (const part of text.split(tokenPattern)) {
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
    const speaker = document.createElement('button');
    speaker.type = 'button';
    speaker.className = 'sentence-play';
    speaker.innerHTML = icon('volume');
    speaker.setAttribute('aria-label', `朗读整句：${text}`);
    speaker.setAttribute('aria-pressed', 'false');
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
    $('current-list').textContent = `List ${number}`;
    $('vocabulary-grid').replaceChildren();
    $('examples-content').replaceChildren();
    targetWords = new Set([...data.vocabulary.map((entry) => normalize(entry.word)), ...(data.targetForms || [])]);
    wordItems = data.vocabulary.map((entry, index) => ({text: entry.word, src: entry.audio, elementId: `vocab-${index}`, type: 'word'}));
    exampleItems = data.examples.map((entry, index) => ({text: entry.text, src: entry.audio, elementId: `example-${index}`, type: 'sentence'}));

    for (const [index, entry] of data.vocabulary.entries()) {
      const button = document.createElement('button');
      button.className = 'word-card';
      button.id = `vocab-${index}`;
      button.type = 'button';
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
      meaning.textContent = entry.meaning;
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
      body.append(createSentence(entry.text, exampleItems[index]), translation);
      row.append(number, body);
      $('examples-content').append(row);
    }

    storePreference('english-reader-list', String(number));
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
      const generation = ++this.generation;
      this.activeElement = $(item.elementId);
      if (this.activeElement) {
        this.activeElement.classList.add(item.type === 'sentence' ? 'is-speaking' : 'is-playing');
        const speaker = item.type === 'sentence' ? this.activeElement.querySelector('.sentence-play') : this.activeElement;
        speaker?.setAttribute('aria-pressed', 'true');
      }
      $('player').hidden = false;
      $('player-kind').textContent = item.type === 'word' ? '单词朗读 · 英式发音' : '句子朗读 · 英式发音';
      $('player-text').textContent = item.text;
      $('player-count').textContent = this.items.length > 1 ? `${String(this.index + 1).padStart(2, '0')} / ${this.items.length}` : '';
      $('screen-reader-status').textContent = `正在朗读：${item.text}`;
      this.updateButtons();
      if (!item.src) return this.fail();
      this.audio.src = item.src;
      this.audio.playbackRate = Number($('speed').value);
      try {
        const started = this.audio.play();
        started?.catch((error) => {
          if (generation !== this.generation || error.name === 'AbortError') return;
          this.fail();
        });
      } catch { this.fail(); }
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
      this.generation++;
      this.items = [];
      this.index = 0;
      this.mode = '';
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.clearHighlight();
      $('player').hidden = true;
      $('player-progress').style.width = '0%';
      $('screen-reader-status').textContent = '';
      this.updateButtons();
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
    option.textContent = `List ${number}${option.disabled ? ' · 待添加' : ''}`;
    $('list-select').append(option);
  }
  const available = Object.keys(course.lists).map(Number).sort((a, b) => a - b);
  const storedList = Number(readPreference('english-reader-list', '1'));
  renderList(course.lists[storedList] ? storedList : available[0]);
  $('list-select').addEventListener('change', () => renderList(Number($('list-select').value)));
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
