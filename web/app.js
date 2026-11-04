import { Deck, GameSession, clipWindow, makeClips, filenameInfo, localMatches, clock } from './core.js';
import { API_ORIGIN } from './config.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const state = { playlist: null, deck: null, round: null, game: null, rounds: 10, seconds: 10, mode: 'random', busy: false, importing: false, epoch: 0, controller: null, availability: new Map(), bindId: null, fileMode: 'auto' };
let context, master, source, envelope, raf, playbackMode = 'reverse', offset = 0, started = 0, playing = false, toastTimer;
let bars = [];

function status(text, type = '') { ui['game-status'].textContent = text; ui['game-status'].className = 'game-status ' + type; }
function importStatus(text, type = '') { ui['import-status'].textContent = text; ui['import-status'].className = 'status-line ' + type; }
function toast(text) { clearTimeout(toastTimer); ui.toast.textContent = text; ui.toast.hidden = false; toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 5500); }
async function audioContext() {
  if (!context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('当前浏览器不支持音频处理，请使用新版 Chrome、Edge 或 Safari。');
    context = new AudioContextClass(); master = context.createGain(); master.gain.value = Number(ui.volume.value) / 100; master.connect(context.destination);
  }
  if (context.state !== 'running') await context.resume();
  return context;
}
async function api(path, payload, signal) {
  const response = await fetch(API_ORIGIN + path, { ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}), signal, credentials: 'omit' });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回异常，请稍后重试。'); }
  if (!response.ok) { const error = new Error(data.error || '请求失败，请重试。'); error.code = data.code; throw error; }
  return data;
}
function setWaveform(buffer) {
  ui.waveform.replaceChildren(); bars = [];
  const samples = buffer?.getChannelData(0);
  for (let i = 0; i < 72; i++) {
    const bar = document.createElement('i'); let value = 0;
    if (samples) { const from = Math.floor(i / 72 * samples.length), to = Math.floor((i + 1) / 72 * samples.length); for (let j = from; j < to; j += Math.max(1, Math.floor((to - from) / 60))) value = Math.max(value, Math.abs(samples[j])); }
    const height = samples ? Math.max(3, Math.min(29, value * 38)) : 5 + 17 * Math.abs(Math.sin(i * .53) * Math.cos(i * .19));
    bar.style.height = height + 'px'; ui.waveform.append(bar); bars.push(bar);
  }
}
function progress(seconds) {
  const duration = state.round?.clips.duration || state.seconds;
  ui.elapsed.textContent = clock(Math.min(seconds, duration)); ui['total-time'].textContent = clock(duration);
  bars.forEach((bar, index) => bar.classList.toggle('played', index / bars.length < seconds / duration));
}
function animate() { if (!playing) return; progress(offset + context.currentTime - started); raf = requestAnimationFrame(animate); }
function stop(reset = true) {
  if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
  if (envelope) { envelope.disconnect(); envelope = null; }
  cancelAnimationFrame(raf); playing = false;
  if (reset) offset = 0;
  document.querySelector('.game-panel').classList.remove('playing');
  renderControls();
  if (reset) progress(0);
}
function pause() { if (!playing) return; offset += context.currentTime - started; stop(false); }
async function play(mode = 'reverse', restart = false) {
  if (!state.round || state.busy) return;
  try {
    const ac = await audioContext();
    if (playing && playbackMode === mode && !restart) { pause(); return; }
    if (playbackMode !== mode || restart) offset = 0;
    stop(false); playbackMode = mode;
    const buffer = state.round.clips[mode];
    if (offset >= buffer.duration - .01) offset = 0;
    const node = ac.createBufferSource(); node.buffer = buffer;
    envelope = ac.createGain(); const now = ac.currentTime; const remaining = buffer.duration - offset;
    envelope.gain.setValueAtTime(0, now); envelope.gain.linearRampToValueAtTime(1, now + Math.min(.008, remaining / 4));
    envelope.gain.setValueAtTime(1, now + Math.max(.009, remaining - .012)); envelope.gain.linearRampToValueAtTime(0, now + remaining);
    node.connect(envelope); envelope.connect(master); source = node; started = now; playing = true;
    node.onended = () => { if (source !== node) return; stop(); progress(buffer.duration); };
    node.start(0, offset);
    const panel = document.querySelector('.game-panel'); panel.classList.add('playing'); panel.classList.toggle('forward', mode === 'forward');
    ui['playback-mode'].textContent = mode === 'reverse' ? 'REVERSE AUDIO' : 'ORIGINAL AUDIO';
    setWaveform(buffer); renderControls(); animate();
  } catch (error) { status('无法播放：' + error.message, 'error'); }
}
function renderControls() {
  const hasRound = !!state.round, hasDeck = !!state.deck;
  const summary = state.game?.summary();
  ui['play-button'].disabled = state.busy || state.importing || !hasDeck;
  ui['play-text'].textContent = state.busy ? '正在准备片段…' : !hasRound ? '随机抽一首' : playing && playbackMode === 'reverse' ? '暂停倒放' : offset > 0 && playbackMode === 'reverse' ? '继续倒放' : '播放倒放';
  ui['play-icon'].textContent = playing && playbackMode === 'reverse' ? 'Ⅱ' : '◀◀';
  ui['replay-button'].disabled = !hasRound || state.busy || state.importing;
  ui['reveal-button'].disabled = !hasRound || state.busy || state.round.revealed || state.importing;
  ui['next-button'].disabled = !hasDeck || state.busy || state.importing || (!hasRound && !state.game?.finished);
  ui['next-button'].textContent = state.game?.finished ? '查看总分 ↗' : state.game?.atLimit ? '完成本局 →' : '下一首 →';
  ui['reset-button'].disabled = !hasDeck || state.busy || state.importing;
  ui['cancel-button'].hidden = !state.busy;
  ui['demo-button'].disabled = state.importing;
  ui['local-button'].disabled = state.importing;
  ui['manage-button'].disabled = state.importing;
  ui['forward-button'].textContent = playing && playbackMode === 'forward' ? 'Ⅱ 暂停原片段' : '▷ 听原片段';
  ui['answer-actions'].hidden = !state.round?.revealed;
  ui['drawn-stat'].textContent = state.deck?.drawn.length || 0;
  ui['correct-stat'].textContent = summary?.score || 0;
  ui['remaining-stat'].textContent = summary ? state.game.finished ? 0 : summary.remaining : '—';
  ui['round-label'].textContent = '第 ' + String(summary?.played || 0).padStart(2, '0') + ' / ' + (summary?.target || state.rounds) + ' 回合';
  ui['player-label'].textContent = state.busy ? 'LOADING YOUR NEXT TRACK' : playing ? playbackMode === 'reverse' ? 'NOW PLAYING BACKWARDS' : 'NOW PLAYING ORIGINAL' : state.game?.finished ? 'GAME COMPLETE' : hasRound ? 'LISTEN. THINK. GUESS.' : 'READY TO REWIND';
  ui['results-button'].hidden = !state.game?.finished;
  const roundsLocked = state.busy || state.importing || !!summary?.played;
  ui['rounds-count'].disabled = roundsLocked; ui['custom-rounds'].disabled = roundsLocked;
  ui['rounds-note'].textContent = summary?.played ? '本局回合数已固定；新一局开始前可修改。' : summary && summary.target < state.rounds ? '歌单只有 ' + summary.target + ' 首，本局最多 ' + summary.target + ' 回合。' : '开局前可修改，游戏中固定回合数。';
  document.querySelector('.game-panel').classList.toggle('loading', state.busy);
}
function clearRound() {
  stop(); state.round = null; playbackMode = 'reverse'; offset = 0;
  ui['track-kicker'].textContent = '你的耳朵，准备好了吗？'; ui['track-title'].textContent = '下一首，会是什么？';
  ui['track-subtitle'].textContent = state.deck ? '按下倒带键，听听随机抽到的那首歌。' : '先准备一张歌单，再按下倒带键。';
  ui['record-symbol'].textContent = '?'; ui['record-caption'].textContent = 'THE MYSTERY TRACK';
  ui['playback-mode'].textContent = 'REVERSE AUDIO'; setWaveform(); progress(0); renderControls();
}
function cancelWork() { state.epoch++; state.controller?.abort(); state.controller = null; state.busy = false; }
function usePlaylist(playlist) {
  cancelWork(); state.playlist = playlist; state.deck = new Deck(playlist.tracks); state.game = new GameSession(state.rounds, playlist.tracks.length); state.availability.clear(); ui['results-dialog'].close(); clearRound();
  ui['loaded-list'].hidden = false; ui['list-name'].textContent = playlist.name;
  updateListMeta(); renderControls();
  status('歌单已就绪。抽一首，看看谁先听出来。');
}
function updateListMeta() {
  const list = state.playlist; if (!list) return;
  const local = list.tracks.filter(t => t.file).length;
  ui['list-meta'].textContent = list.tracks.length + ' 首 · ' + (list.source === 'netease' ? '网易云歌单' : list.source === 'demo' ? '合成旋律演示' : '本地歌单') + (local && list.source === 'netease' ? ' · 已绑定 ' + local + ' 首' : '');
}
ui['playlist-form'].addEventListener('submit', async event => {
  event.preventDefault(); if (state.importing) return;
  cancelWork(); stop(); state.importing = true; renderControls(); ui['import-button'].disabled = true; ui['import-button'].firstElementChild.textContent = '读取并补全歌曲…';
  importStatus('正在读取歌单；大歌单需要分批获取详情，请稍候。');
  try {
    const playlist = await api('/api/playlist', { input: ui['playlist-input'].value }, AbortSignal.timeout(120000));
    usePlaylist(playlist);
    importStatus(playlist.missing ? '已读入 ' + playlist.tracks.length + ' / ' + playlist.total + ' 首；有 ' + playlist.missing + ' 首未返回详情。' : '已完整读取 ' + playlist.tracks.length + ' 首，抽歌时检查音源。', 'success');
    try { localStorage.setItem('rewind:lastInput', ui['playlist-input'].value); } catch {}
  } catch (error) { importStatus(error.name === 'TimeoutError' ? '读取超时，请稍后重试。' : error.message, 'error'); }
  finally { state.importing = false; ui['import-button'].disabled = false; ui['import-button'].firstElementChild.textContent = '读取歌单'; renderControls(); }
});

function demoBuffer(track, ac) {
  const patterns = {
    twinkle: [60,60,67,67,69,69,67,0,65,65,64,64,62,62,60,0,67,67,65,65,64,64,62,0,67,67,65,65,64,64,62,0],
    joy: [64,64,65,67,67,65,64,62,60,60,62,64,64,62,62,0,64,64,65,67,67,65,64,62,60,60,62,64,62,60,60,0],
    tiger: [60,62,64,60,60,62,64,60,64,65,67,0,64,65,67,0,67,69,67,65,64,60,0,0,67,69,67,65,64,60,0,0],
  };
  const notes = patterns[track.pattern]; const beat = .42; const duration = notes.length * beat + .4;
  const buffer = ac.createBuffer(1, Math.ceil(duration * ac.sampleRate), ac.sampleRate); const samples = buffer.getChannelData(0);
  notes.forEach((note, index) => {
    if (!note) return;
    const frequency = 440 * 2 ** ((note - 69) / 12), from = Math.floor(index * beat * ac.sampleRate);
    for (let i = 0; i < Math.floor(beat * ac.sampleRate); i++) {
      const t = i / ac.sampleRate, decay = Math.min(t / .008, 1) * Math.exp(-t * 5.5) * Math.min((beat - t) / .035, 1);
      samples[from + i] += .35 * decay * (Math.sin(2 * Math.PI * frequency * t) + .23 * Math.sin(4 * Math.PI * frequency * t));
    }
  });
  return buffer;
}
ui['demo-button'].addEventListener('click', () => {
  if (state.importing) return;
  usePlaylist({ name: '倒带体验 · 三首熟悉的旋律', source: 'demo', tracks: [
    { id: 'demo-1', title: '小星星', artist: '合成旋律 · 演示曲', source: 'demo', pattern: 'twinkle' },
    { id: 'demo-2', title: '欢乐颂', artist: '合成旋律 · 演示曲', source: 'demo', pattern: 'joy' },
    { id: 'demo-3', title: '两只老虎', artist: '合成旋律 · 演示曲', source: 'demo', pattern: 'tiger' },
  ] });
  importStatus('演示曲库已就绪：3 首浏览器合成旋律。', 'success');
});

async function decode(track, ac, signal) {
  if (track.source === 'demo') return { buffer: demoBuffer(track, ac), trial: false };
  let bytes, trial = false;
  if (track.file) {
    if (track.file.size > 100 * 1024 * 1024) throw new Error('本地文件超过 100 MB，请使用较小的音频。');
    bytes = await track.file.arrayBuffer();
  } else {
    const response = await fetch(API_ORIGIN + '/api/audio?id=' + encodeURIComponent(track.id), { signal, credentials: 'omit' });
    if (!response.ok) { const data = await response.json(); const error = new Error(data.error || '未能取得音频。'); error.code = data.code; throw error; }
    trial = response.headers.get('x-audio-trial') === 'true'; bytes = await response.arrayBuffer();
  }
  signal?.throwIfAborted();
  let buffer;
  try { buffer = await ac.decodeAudioData(bytes); } catch { throw new Error('浏览器无法解码这首音频，请检查文件，或换成 MP3 / WAV。'); }
  signal?.throwIfAborted();
  if (buffer.length * buffer.numberOfChannels * 4 > 220 * 1024 * 1024) throw new Error('音频解码后过大，请裁短后再导入。');
  if (!buffer.length) throw new Error('音频文件是空的。');
  return { buffer, trial };
}
async function draw() {
  if (!state.deck || state.busy || state.importing) return;
  if (state.game.finished) { showResults(); return; }
  if (state.game.atLimit) { if (state.round && !state.round.revealed) { reveal(); status('这是最后一题。标记猜对或没猜中即可结算，也可再点「完成本局」，未标记按 0 分。'); return; } finishGame(); return; }
  if (!state.deck.queue.length) { if (state.game.records.length) finishGame('exhausted'); else status('没有待抽歌曲，请绑定本地音频或开始新一局重试。', 'error'); return; }
  cancelWork(); clearRound(); state.busy = true; const epoch = state.epoch;
  const controller = new AbortController(); state.controller = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
  renderControls(); let skipped = 0, lastError;
  try {
    const ac = await audioContext();
    for (let attempt = 0; attempt < 8 && state.deck.queue.length; attempt++) {
      signal.throwIfAborted(); status('正在随机抽歌并检查音源…' + (skipped ? ' 已跳过 ' + skipped + ' 首未取得音频的歌曲。' : ''));
      let candidate = state.deck.queue[0];
      if (candidate.source === 'netease' && !candidate.file && !state.availability.get(candidate.id)) {
        const batch = state.deck.queue.slice(0, 20).filter(t => t.source === 'netease' && !t.file && !state.availability.get(t.id));
        const checked = await api('/api/check', { ids: batch.map(t => t.id) }, signal);
        if (epoch !== state.epoch) return;
        checked.available.forEach(id => state.availability.set(id, true));
        state.deck.skip(checked.unavailable); skipped += checked.unavailable.length; renderControls();
        candidate = state.deck.queue[0]; if (!candidate) break;
        if (candidate.source === 'netease' && !candidate.file && !state.availability.get(candidate.id)) continue;
      }
      status('正在生成倒放片段…' + (skipped ? ' 已跳过 ' + skipped + ' 首。' : ''));
      let loaded;
      try { loaded = await decode(candidate, ac, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        if (error.code?.startsWith('UPSTREAM_')) throw error;
        lastError = error; state.deck.skip([candidate.id]); skipped++; renderControls(); continue;
      }
      if (epoch !== state.epoch) return;
      const window = clipWindow(loaded.buffer, state.seconds, state.mode);
      const clips = makeClips(ac, loaded.buffer, window);
      state.deck.take(candidate.id); const record = state.game.add(candidate); state.round = { track: candidate, record, clips, trial: loaded.trial, revealed: false, verdict: null };
      ui['track-kicker'].textContent = '听倒放，猜猜这是哪首歌'; ui['track-title'].textContent = '这一首，你听出来了吗？';
      ui['track-subtitle'].textContent = clock(clips.duration) + ' 倒放片段 · 歌名和歌手已隐藏';
      ui['record-symbol'].textContent = '?'; ui['record-caption'].textContent = loaded.trial ? 'PREVIEW CLIP' : 'THE MYSTERY TRACK';
      ui['correct-button'].classList.remove('selected'); ui['incorrect-button'].classList.remove('selected');
      setWaveform(clips.reverse); progress(0);
      status((loaded.trial ? '使用网易云提供的试听音频。' : '仔细听，可以反复重播同一个片段。') + (skipped ? ' 本次跳过了 ' + skipped + ' 首未取得音频的歌曲。' : ''));
      state.busy = false; renderControls(); await play('reverse', true); return;
    }
    if (!state.deck.queue.length && state.game.records.length) finishGame('exhausted');
    else status(lastError ? lastError.message + ' 可打开主持人歌单绑定本地音频后重试。' : '这批歌曲没有取得可用音频。可继续抽取，或打开主持人歌单绑定本地音频。', 'error');
  } catch (error) {
    if (epoch !== state.epoch) return;
    status(signal.aborted ? controller.signal.aborted ? '已取消加载。' : '载入超时，请重试或使用本地音频。' : error.message, 'error');
  } finally { if (epoch === state.epoch) { state.busy = false; state.controller = null; renderControls(); } }
}
function reveal() {
  if (!state.round || state.round.revealed || state.busy) return;
  stop(); state.round.revealed = true; const { track, clips } = state.round;
  ui['track-kicker'].textContent = '答案揭晓 · 原来是这首'; ui['track-title'].textContent = track.title; ui['track-subtitle'].textContent = track.artist;
  ui['record-symbol'].textContent = '♫'; ui['record-caption'].textContent = 'MYSTERY SOLVED';
  ui['song-link'].hidden = track.source !== 'netease'; if (track.source === 'netease') ui['song-link'].href = 'https://music.163.com/song?id=' + encodeURIComponent(track.id);
  status('片段位置 ' + clock(clips.start) + ' — ' + clock(clips.start + clips.duration) + (state.round.trial ? '（试听音频内）' : '') + '。点「听原片段」对照，再记下这题的结果。');
  renderControls();
}
function verdict(correct) {
  if (!state.round?.revealed) return;
  state.round.verdict = correct; state.game.grade(state.game.records.length - 1, correct);
  ui['correct-button'].classList.toggle('selected', correct); ui['incorrect-button'].classList.toggle('selected', !correct); renderControls();
  if (state.game.finished) renderResults();
  else if (state.game.atLimit) finishGame();
}
function renderResults() {
  const game = state.game; if (!game) return; const summary = game.summary();
  ui['results-title'].textContent = game.reason === 'exhausted' ? '可用歌曲已抽完' : '本局结束';
  ui['summary-note'].textContent = game.reason === 'exhausted' ? '计划 ' + summary.target + ' 回合，实际完成 ' + summary.played + ' 回合；其余歌曲未取得可用音频，本局提前结算。' : '完成 ' + summary.played + ' 回合' + (summary.target < summary.requested ? '（设置 ' + summary.requested + ' 回合，歌单只有 ' + summary.target + ' 首）' : '') + '。看看这次耳朵拿下了多少分。';
  for (const key of ['score', 'correct', 'incorrect', 'unscored']) ui['summary-' + key].textContent = summary[key];
  ui['summary-max'].textContent = '/ ' + summary.played + ' 分'; ui['summary-accuracy'].textContent = summary.accuracy + '%';
  ui['summary-tracks'].replaceChildren();
  game.records.forEach((record, index) => {
    const row = document.createElement('div'); row.className = 'result-row';
    const number = document.createElement('span'); number.className = 'result-number'; number.textContent = String(index + 1).padStart(2, '0');
    const description = document.createElement('div'); const title = document.createElement('strong'); title.textContent = record.title; const artist = document.createElement('small'); artist.textContent = record.artist; description.append(title, artist);
    const result = document.createElement('span'); result.className = record.verdict === true ? 'result-points correct' : 'result-points'; result.textContent = record.verdict === true ? '猜对 +1' : record.verdict === false ? '没猜中 0' : '未标记 0'; row.append(number, description, result); ui['summary-tracks'].append(row);
  });
}
function showResults() { if (!state.game?.finished) return; stop(); renderResults(); if (!ui['results-dialog'].open) ui['results-dialog'].showModal(); }
function finishGame(reason = 'completed') { state.game.finish(reason); stop(); renderControls(); status('本局已结束，总分 ' + state.game.summary().score + ' 分。可查看总分或开始新一局。'); showResults(); }
function newGame() {
  if (!state.deck) return; ui['reset-dialog'].close(); ui['results-dialog'].close(); cancelWork(); state.deck.reset(); state.game = new GameSession(state.rounds, state.deck.tracks.length); state.availability.clear(); clearRound(); status('已重新洗牌。可先设置回合数，再开始新一局。');
}
function changeRounds() {
  if (state.game?.records.length || state.busy || state.importing) return;
  const custom = ui['rounds-count'].value === 'custom'; ui['custom-rounds-wrap'].hidden = !custom;
  const rounds = Number(custom ? ui['custom-rounds'].value : ui['rounds-count'].value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) { ui['custom-rounds'].value = state.rounds; toast('每局回合数须为 1–100 的整数。'); return; }
  state.rounds = rounds; if (state.deck) state.game = new GameSession(rounds, state.deck.tracks.length); renderControls();
}
ui['rounds-count'].addEventListener('change', changeRounds); ui['custom-rounds'].addEventListener('change', changeRounds);
ui['results-button'].addEventListener('click', showResults); ui['results-new-game'].addEventListener('click', newGame);
ui['play-button'].addEventListener('click', () => state.round ? play('reverse') : draw());
ui['next-button'].addEventListener('click', draw);
ui['replay-button'].addEventListener('click', () => play('reverse', true));
ui['reveal-button'].addEventListener('click', reveal);
ui['forward-button'].addEventListener('click', () => play('forward'));
ui['correct-button'].addEventListener('click', () => verdict(true)); ui['incorrect-button'].addEventListener('click', () => verdict(false));
ui['cancel-button'].addEventListener('click', () => { cancelWork(); clearRound(); status('已取消加载，可以重新抽取。'); });
ui['duration-options'].addEventListener('click', event => {
  const button = event.target.closest('[data-seconds]'); if (!button) return; state.seconds = Number(button.dataset.seconds);
  for (const node of ui['duration-options'].children) { node.classList.toggle('selected', node === button); node.setAttribute('aria-pressed', String(node === button)); }
  if (!state.round) progress(0);
});
ui['clip-mode'].addEventListener('change', () => { state.mode = ui['clip-mode'].value; });
ui.volume.addEventListener('input', () => { ui['volume-value'].textContent = ui.volume.value + '%'; if (master) master.gain.setTargetAtTime(Number(ui.volume.value) / 100, context.currentTime, .015); });
ui['reset-button'].addEventListener('click', () => ui['reset-dialog'].showModal());
ui['confirm-reset'].addEventListener('click', newGame);
ui['help-button'].addEventListener('click', () => ui['help-dialog'].showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
ui['fullscreen-button'].addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('当前浏览器不支持全屏，可以使用浏览器的全屏功能。'); }
});
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement); ui['fullscreen-button'].textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏'; });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
  if (event.code === 'Space') { if (event.target.closest('button,a')) return; event.preventDefault(); if (!ui['play-button'].disabled) ui['play-button'].click(); }
  if (event.key.toLowerCase() === 'r') reveal();
  if (event.key.toLowerCase() === 'n' && !ui['next-button'].disabled) draw();
});
window.addEventListener('pagehide', () => { cancelWork(); stop(); });

function pickFiles(mode = 'auto', id = null) { if (state.importing) return; state.fileMode = mode; state.bindId = id; ui['file-input'].multiple = !id; ui['file-input'].click(); }
ui['local-button'].addEventListener('click', () => pickFiles('local'));
ui['bind-button'].addEventListener('click', () => pickFiles('bind'));
ui['file-input'].addEventListener('change', () => {
  const files = [...ui['file-input'].files].filter(f => /\.(mp3|wav|flac|m4a|ogg|aac|opus|webm|aiff?)$/i.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) { toast('请选择普通音频文件，例如 MP3、WAV 或 FLAC；不支持加密 NCM 文件。'); return; }
  cancelWork(); stop();
  if (state.fileMode === 'local') {
    const tracks = files.map((file, index) => ({ id: 'local-' + index, ...filenameInfo(file.name), source: 'local', file }));
    usePlaylist({ name: '我的本地歌单', source: 'local', tracks }); importStatus('已导入 ' + tracks.length + ' 首本地音频，不会上传文件。', 'success');
    toast('已建立本地歌单；主持人歌单中可以编辑歌名和歌手。');
  } else if (state.playlist) {
    let matched = 0, ambiguous = 0;
    for (const file of files) {
      const matches = state.bindId ? state.playlist.tracks.filter(t => t.id === state.bindId) : localMatches(file, state.playlist.tracks);
      if (matches.length !== 1) { if (matches.length > 1) ambiguous++; continue; }
      const track = matches[0]; track.file = file; matched++; state.availability.delete(track.id);
      if (state.deck.failed.has(track.id)) { state.deck.failed.delete(track.id); if (!state.deck.drawn.some(t => t.id === track.id)) state.deck.queue.push(track); }
    }
    updateListMeta(); renderControls(); renderTrackList();
    toast('已绑定 ' + matched + ' 首。' + (files.length > matched ? '其余 ' + (files.length - matched) + ' 个文件未匹配' + (ambiguous ? '（有同名歌曲）' : '') + '，可在对应歌曲右侧逐一选择。' : '音频仅在本地使用。'));
  }
  ui['file-input'].value = ''; state.bindId = null; renderControls();
});
function renderTrackList() {
  if (!state.playlist) return;
  const query = ui['track-search'].value.trim().toLocaleLowerCase(); const tracks = state.playlist.tracks.filter(t => (t.title + ' ' + t.artist + ' ' + t.id).toLocaleLowerCase().includes(query));
  ui['track-list'].replaceChildren(); ui['manage-count'].textContent = '共 ' + tracks.length + ' 首 · 已绑定本地音频 ' + state.playlist.tracks.filter(t => t.file).length + ' 首';
  for (const [index, track] of tracks.slice(0, 100).entries()) {
    const row = document.createElement('div'); row.className = 'track-row';
    const number = document.createElement('span'); number.className = 'track-number'; number.textContent = String(index + 1).padStart(2, '0');
    const description = document.createElement('div'); description.className = 'track-description';
    if (track.source === 'local') {
      for (const [field, label] of [['title', '歌名'], ['artist', '歌手']]) {
        const input = document.createElement('input'); input.value = track[field]; input.setAttribute('aria-label', label); input.addEventListener('change', () => { track[field] = input.value.trim() || (field === 'title' ? filenameInfo(track.file.name).title : '本地音频'); if (state.round?.revealed && state.round.track.id === track.id) { ui['track-title'].textContent = track.title; ui['track-subtitle'].textContent = track.artist; } }); description.append(input);
      }
    } else { const title = document.createElement('strong'); title.textContent = track.title; const artist = document.createElement('small'); artist.textContent = track.artist; description.append(title, artist); }
    const badge = document.createElement('span'); badge.className = 'track-badge'; badge.textContent = track.file ? '本地音频 ✓' : state.deck.failed.has(track.id) ? '已跳过' : state.deck.drawn.some(t => t.id === track.id) ? '已抽取' : state.availability.has(track.id) ? '已取得音源' : track.source === 'demo' ? '合成演示' : '待检查音源';
    row.append(number, description, badge);
    if (track.source === 'netease') { const bind = document.createElement('button'); bind.textContent = track.file ? '更换' : '绑定'; bind.addEventListener('click', () => pickFiles('bind', track.id)); row.append(bind); }
    ui['track-list'].append(row);
  }
  ui['more-tracks'].textContent = tracks.length > 100 ? '当前显示前 100 首，请搜索定位其余歌曲。' : tracks.length ? '' : '没有找到匹配的歌曲。';
}
ui['manage-button'].addEventListener('click', () => { if (playing) pause(); renderTrackList(); ui['manage-dialog'].showModal(); });
ui['track-search'].addEventListener('input', renderTrackList);
try { ui['playlist-input'].value = localStorage.getItem('rewind:lastInput') || ''; } catch {}
setWaveform(); progress(0); renderControls();
