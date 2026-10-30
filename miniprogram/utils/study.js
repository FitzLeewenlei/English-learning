const storage = require('./storage');
const srs = require('./srs');
const config = require('../config');
const catalog = require('./course');
const api = require('./api');
let syncing = false;
function progress() { const stored=storage.get('progress',{},true),active={};catalog.allWords().forEach(w=>{if(stored[w.id])active[w.id]=stored[w.id];});return active; }
function goal() { return Math.max(1, Math.min(100, Number(storage.get('dailyGoal', config.defaultDailyGoal, true)) || 15)); }
function setGoal(value) { storage.set('dailyGoal', Math.max(1, Math.min(100, Number(value) || 15)), true); }
function enqueue(event) {
  const events = storage.get('pendingEvents', [], true);
  if (events.length >= 2000) throw new Error('待同步记录较多，请先联网同步后再继续背词。');
  events.push(event);
  if (!storage.set('pendingEvents', events, true)) throw new Error('学习记录未保存，请检查手机空间。');
}
function rate(word, rating, detail) {
  if (!['again', 'hard', 'good'].includes(rating)) throw new Error('无效的记忆反馈');
  const now = Date.now(), all = progress();
  const event = { id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 12),
    wordId: word.id, listId: word.listId, rating, at: now, mode:(detail&&detail.mode)||'recall' };
  if(detail&&typeof detail.answerCorrect==='boolean')event.answerCorrect=detail.answerCorrect;
  const profile=storage.get('profile',null);
  if(profile&&profile.role==='student')enqueue(event);
  all[word.id] = srs.nextReview(all[word.id], rating, now);
  all[word.id].wordId = word.id; all[word.id].listId = word.listId;
  storage.set('progress', all, true);
  sync().catch(() => {});
  return all[word.id];
}
function summary() {
  const all = progress(), now = Date.now(), today = srs.dateKey(now);
  const values = Object.keys(all).map(k => all[k]);
  return { learned: values.length, due: values.filter(p => p.dueAt <= now).length,
    newToday: values.filter(p => srs.dateKey(p.firstLearnedAt) === today).length,
    reviewedToday: values.filter(p => p.lastDay === today && srs.dateKey(p.firstLearnedAt) !== today).length,
    pending: storage.get('pendingEvents', [], true).length, goal: goal(),
    lastSync: storage.get('lastSync', 0, true),totalCards:catalog.allWords().length,
    totalEntries:Object.keys(catalog.course.lists).reduce((n,id)=>n+catalog.course.lists[id].vocabulary.length,0),unitCount:Object.keys(catalog.course.lists).length };
}
function queue(kind) {
  const all = progress(), now = Date.now();
  const words = catalog.allWords();
  if (kind === 'review') return words.filter(w => all[w.id] && all[w.id].dueAt <= now).sort((a,b) => all[a.id].dueAt - all[b.id].dueAt);
  return words.filter(w => !all[w.id]).slice(0, Math.max(0, goal() - summary().newToday));
}
async function sync() {
  if (syncing || !api.enabled()) return;
  const profile = storage.get('profile', null);
  if (!profile || profile.role !== 'student') return;
  syncing = true;
  const scope = storage.scope();
  try {
    // The trusted cloud identity must match the local queue owner before any upload.
    const identity=await api.call('me');
    if(!identity.profile||identity.profile.id!==scope){api.saveProfile(identity.profile||null);return;}
    let events = storage.get('pendingEvents', [], true);
    while (events.length) {
      const batch = events.slice(0, 40);
      await api.call('syncStudy', { events: batch, dailyGoal: goal() });
      if (storage.scope() !== scope) return;
      const ids = new Set(batch.map(e => e.id));
      events = storage.get('pendingEvents', [], true).filter(e => !ids.has(e.id));
      storage.set('pendingEvents', events, true);
    }
    const remote = await api.call('myProgress');
    if (storage.scope() !== scope) return;
    const merged = remote.progress || {};
    const newPending = storage.get('pendingEvents', [], true);
    newPending.forEach(e => { if(!merged[e.wordId]||e.at>merged[e.wordId].lastReviewedAt)merged[e.wordId] = { ...srs.nextReview(merged[e.wordId], e.rating, e.at), wordId:e.wordId, listId:e.listId }; });
    storage.set('progress', merged, true);
    storage.set('lastSync', Date.now(), true);
  } finally { syncing = false; }
}
module.exports = { progress, goal, setGoal, rate, summary, queue, sync };
