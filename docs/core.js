export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export class Deck {
  constructor(tracks) { this.tracks = tracks; this.reset(); }
  reset() { this.queue = shuffle(this.tracks); this.drawn = []; this.failed = new Set(); }
  skip(ids) { const set = new Set(ids); ids.forEach(id => this.failed.add(id)); this.queue = this.queue.filter(t => !set.has(t.id)); }
  take(id) { const index = this.queue.findIndex(t => t.id === id); if (index < 0) return null; const [track] = this.queue.splice(index, 1); this.drawn.push(track); return track; }
}
export class GameSession {
  constructor(rounds, available) {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('每局回合数须为 1–100 的整数。');
    this.requested = rounds; this.target = Math.min(rounds, available); this.records = []; this.finished = false; this.reason = null;
  }
  get atLimit() { return this.records.length >= this.target; }
  add(track) {
    if (this.finished || this.atLimit) throw new Error('本局已经结束，不能继续出题。');
    if (this.records.some(r => r.id === track.id)) throw new Error('本局不能重复出题。');
    const record = { id: track.id, title: track.title, artist: track.artist, verdict: null };
    this.records.push(record); return record;
  }
  grade(index, correct) {
    if (typeof correct !== 'boolean' || !this.records[index]) throw new Error('无效的计分结果。');
    this.records[index].verdict = correct;
  }
  finish(reason = 'completed') { this.finished = true; this.reason = reason; return this.summary(); }
  summary() {
    const played = this.records.length, correct = this.records.filter(r => r.verdict === true).length;
    const incorrect = this.records.filter(r => r.verdict === false).length;
    return { played, correct, incorrect, unscored: played - correct - incorrect, score: correct,
      target: this.target, requested: this.requested, remaining: Math.max(0, this.target - played), accuracy: played ? Math.round(correct / played * 100) : 0 };
  }
}
export function clipWindow(buffer, seconds, mode, random = Math.random) {
  const length = Math.min(buffer.length, Math.max(1, Math.round(seconds * buffer.sampleRate)));
  const maxStart = buffer.length - length;
  let start = mode === 'intro' ? 0 : mode === 'middle' ? Math.floor(maxStart / 2) : Math.floor(random() * (maxStart + 1));
  if (mode === 'random' && maxStart > 0) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const energy = offset => { let sum = 0; for (const data of channels) for (let i = 0; i < length; i += Math.max(1, Math.floor(length / 300))) sum += data[offset + i] ** 2; return sum; };
    if (energy(start) < 0.08) {
      let best = energy(start);
      for (let i = 0; i < 5; i++) { const candidate = Math.floor(random() * (maxStart + 1)); const score = energy(candidate); if (score > best) { start = candidate; best = score; } }
    }
  }
  return { start, length };
}
export function makeClips(context, original, window) {
  const forward = context.createBuffer(original.numberOfChannels, window.length, original.sampleRate);
  const reverse = context.createBuffer(original.numberOfChannels, window.length, original.sampleRate);
  for (let channel = 0; channel < original.numberOfChannels; channel++) {
    const samples = original.getChannelData(channel).subarray(window.start, window.start + window.length);
    forward.getChannelData(channel).set(samples);
    const backwards = reverse.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) backwards[i] = samples[samples.length - i - 1];
  }
  return { forward, reverse, start: window.start / original.sampleRate, duration: window.length / original.sampleRate };
}
export function filenameInfo(name) {
  const stem = name.replace(/\.[^.]+$/, ''); const parts = stem.split(/\s+-\s+/);
  return parts.length >= 2 ? { artist: parts.shift(), title: parts.join(' - ') } : { title: stem, artist: '本地音频' };
}
export function normalized(value) { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
export function localMatches(file, tracks) {
  const stem = file.name.replace(/\.[^.]+$/, ''); const id = stem.match(/(?:^|\D)(\d{5,18})(?:\D|$)/)?.[1];
  if (id) { const matches = tracks.filter(t => t.id === id); if (matches.length) return matches; }
  const key = normalized(stem);
  return tracks.filter(t => key === normalized(t.title) || key === normalized(t.artist + t.title) || key === normalized(t.title + t.artist));
}
export function clock(seconds) { const n = Math.max(0, Math.floor(seconds || 0)); return Math.floor(n / 60).toString().padStart(2, '0') + ':' + (n % 60).toString().padStart(2, '0'); }
