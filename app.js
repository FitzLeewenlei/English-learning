(() => {
  'use strict';
  const data = window.READING;
  const $ = (id) => document.getElementById(id);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const targetWords = new Set(data.vocabulary.map((entry) => entry.word.toLowerCase()));
  const wordAudio = (word) => `audio/words/${word.toLowerCase()}.mp3`;
  const wordItems = data.vocabulary.map((entry, index) => ({ text: entry.word, src: entry.audio, elementId: `vocab-${index}`, type: 'word' }));
  const sentences = data.paragraphs.flat();
  const sentenceItems = sentences.map((text, index) => ({ text, src: `audio/sentences/${String(index + 1).padStart(2, '0')}.mp3`, elementId: `sentence-${index}`, type: 'sentence' }));

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

  let sentenceIndex = 0;
  for (const paragraph of data.paragraphs) {
    const group = document.createElement('div');
    group.className = 'paragraph-group';
    for (const text of paragraph) {
      const index = sentenceIndex++;
      const line = document.createElement('p');
      line.className = 'sentence';
      line.id = `sentence-${index}`;
      const parts = text.split(/([A-Za-z]+(?:'[A-Za-z]+)?)/g);
      let tokenIndex = 0;
      for (const part of parts) {
        if (/^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(part)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'word-token';
          if (targetWords.has(part.toLowerCase())) button.classList.add('target-word');
          button.id = `token-${index}-${tokenIndex++}`;
          button.textContent = part;
          button.setAttribute('aria-label', `朗读单词 ${part}`);
          button.addEventListener('click', () => player.start([{ text: part, src: wordAudio(part), elementId: button.id, type: 'word' }], 'word'));
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
      speaker.addEventListener('click', () => player.start([sentenceItems[index]], 'sentence'));
      line.append(speaker);
      group.append(line);
    }
    $('article-content').append(group);
  }
  for (const text of data.translations) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    $('translation-content').append(paragraph);
  }

  function readPreference(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function storePreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* The controls still work when storage is disabled. */ }
  }
  const storedSpeed = readPreference('garden-reader-speed', '1');
  $('speed').value = ['0.75', '1', '1.25'].includes(storedSpeed) ? storedSpeed : '1';
  $('show-translation').checked = readPreference('garden-reader-translation', 'true') !== 'false';
  $('translation-panel').hidden = !$('show-translation').checked;
  $('show-translation').addEventListener('change', () => {
    $('translation-panel').hidden = !$('show-translation').checked;
    storePreference('garden-reader-translation', String($('show-translation').checked));
  });

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
      this.stop();
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
      const vocabActive = this.mode === 'vocabulary' && this.items.length > 0;
      const articleActive = this.mode === 'reading' && this.items.length > 0;
      $('play-vocabulary').innerHTML = icon(vocabActive ? 'stop' : 'play') + `<span>${vocabActive ? '停止朗读' : '依次朗读'}</span>`;
      $('play-reading').innerHTML = icon(articleActive ? 'stop' : 'play') + `<span>${articleActive ? '停止朗读' : '朗读文章'}</span>`;
      $('play-vocabulary').setAttribute('aria-pressed', String(vocabActive));
      $('play-reading').setAttribute('aria-pressed', String(articleActive));
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
  player.updateButtons();
  $('play-vocabulary').addEventListener('click', () => {
    if (player.mode === 'vocabulary') player.stop();
    else player.start(wordItems, 'vocabulary');
  });
  $('play-reading').addEventListener('click', () => {
    if (player.mode === 'reading') player.stop();
    else player.start(sentenceItems, 'reading');
  });
  $('stop-reading').addEventListener('click', () => player.stop());
  $('speed').addEventListener('change', () => {
    player.audio.playbackRate = Number($('speed').value);
    storePreference('garden-reader-speed', $('speed').value);
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') player.stop(); });
  window.addEventListener('pagehide', () => player.stop());
})();
