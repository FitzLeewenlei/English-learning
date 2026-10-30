// This is a transparent, configurable spaced-review rule, not an individual memory prediction.
const DAY = 86400000;
const INTERVALS = [1, 3, 7, 14, 30, 60];
function dateKey(ms) {
  // Every learner and teacher uses the same Asia/Shanghai calendar day.
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}
function nextReview(previous, rating, now) {
  const old = previous || {};
  const priorStage = Number.isInteger(old.stage) ? old.stage : -1;
  let stage, dueAt;
  if (rating === 'again') { stage = -1; dueAt = now + 10 * 60000; }
  else if (rating === 'hard') { stage = Math.max(0, priorStage - 1); dueAt = now + DAY; }
  else { stage = Math.min(INTERVALS.length - 1, priorStage + 1); dueAt = now + INTERVALS[stage] * DAY; }
  return { ...old, stage, dueAt, lastReviewedAt: now, firstLearnedAt: old.firstLearnedAt || now,
    reviews: (old.reviews || 0) + 1, lapses: (old.lapses || 0) + (rating === 'again' ? 1 : 0),
    lastRating: rating, lastDay: dateKey(now) };
}
module.exports = { DAY, INTERVALS, dateKey, nextReview };
