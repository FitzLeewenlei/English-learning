const media = require('./media');
let audio = null, items = [], index = 0, mode = '', generation = 0, timer = null;
let speed = 1, paused = true, loading = false, stopped = true, awaitingStart = false, sourceReady = false;
let baseTime = 0, baseWall = 0, duration = 0, expectedSeek = null;
const listeners = [];
function state() {
  let current = baseTime;
  if (!paused && !loading && !stopped && baseWall) current += (Date.now() - baseWall) / 1000 * speed;
  current = Math.max(0, duration ? Math.min(duration, current) : current);
  return { active: !stopped, item: items[index] || null, index, total: items.length, mode,
    paused, loading, current, duration, speed };
}
function emit() { const snapshot = state(); listeners.slice().forEach(fn => fn(snapshot)); }
function syncClock() { if (!audio || expectedSeek !== null) return; baseTime = audio.currentTime || 0; baseWall = Date.now(); duration = audio.duration || duration; }
function ensureAudio() {
  if (audio) return;
  if (wx.setInnerAudioOption) wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: false });
  audio = wx.createInnerAudioContext();
  audio.autoplay = false;
  audio.onCanplay(() => {
    if (stopped) return;
    duration = audio.duration || duration;
    if (awaitingStart) { awaitingStart = false; audio.play(); }
  });
  audio.onPlay(() => { awaitingStart = false; paused = false; loading = false; syncClock(); emit(); });
  audio.onPause(() => { syncClock(); paused = true; emit(); });
  audio.onWaiting(() => { syncClock(); loading = true; emit(); });
  audio.onTimeUpdate(() => { if (stopped) return; loading = false; syncClock(); emit(); });
  audio.onSeeking(() => { loading = true; emit(); });
  audio.onSeeked(() => { expectedSeek = null; loading = false; syncClock(); emit(); });
  audio.onEnded(() => {
    if (stopped) return;
    const completed = items[index];
    listeners.slice().forEach(fn => fn({ ...state(), completed }));
    if (index + 1 < items.length) { index += 1; playCurrent(); } else stop();
  });
  audio.onError(err => {
    if (stopped) return;
    stop();
    wx.showToast({ title: '播放失败，请重试或检查网络', icon: 'none', duration: 2500 });
    console.warn('Audio error', err);
  });
  if (wx.onAudioInterruptionBegin) wx.onAudioInterruptionBegin(() => { if (!stopped) audio.pause(); });
}
function playCurrent() {
  ensureAudio();
  const request = ++generation;
  audio.stop();
  stopped = false; paused = true; loading = true; duration = 0; baseTime = 0; baseWall = 0;
  expectedSeek = null; awaitingStart = false; sourceReady = false;
  emit();
  media.resolveAudio(items[index].src).then(src => {
    if (request !== generation || stopped) return;
    audio.src = src;
    sourceReady = true;
    audio.playbackRate = speed;
    awaitingStart = true;
    // Calling play after assigning src is supported; onCanplay supplies a second safe start.
    audio.play();
  }).catch(err => {
    if (request !== generation) return;
    stop(); wx.showToast({ title: err.message || '录音暂未加载成功', icon: 'none', duration: 3000 });
  });
  if (!timer) timer = setInterval(() => { if (!stopped && !paused && !loading) emit(); }, 100);
}
function start(next, nextMode) {
  if (!next || !next.length) return;
  stop(); items = next; index = 0; mode = nextMode; playCurrent();
}
function stop() {
  generation += 1; stopped = true; paused = true; loading = false; awaitingStart = false; sourceReady = false;
  if (audio) audio.stop();
  if (timer) clearInterval(timer);
  timer = null; expectedSeek = null; baseTime = 0; duration = 0; emit();
}
function toggle() { if (!audio || stopped || !sourceReady) return; if (paused) audio.play(); else audio.pause(); }
function seek(delta) {
  if (!audio || stopped || !duration) return;
  expectedSeek = Math.max(0, Math.min(duration, (audio.currentTime || baseTime) + delta));
  baseTime = expectedSeek; baseWall = Date.now(); audio.seek(expectedSeek); emit();
}
function setSpeed(next) {
  speed = Number(next) || 1;
  if (audio) { syncClock(); audio.playbackRate = speed; }
  emit();
}
function subscribe(fn) { listeners.push(fn); fn(state()); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
module.exports = { start, stop, toggle, seek, setSpeed, subscribe, state };
