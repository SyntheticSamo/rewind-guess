import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck, GameSession, clipWindow, makeClips, localMatches, filenameInfo, shuffle } from '../web/core.js';

function audio(channels, sampleRate = 10) {
  const data = channels.map(c => Float32Array.from(c));
  return { numberOfChannels: data.length, length: data[0].length, sampleRate, get duration() { return this.length / sampleRate; }, getChannelData: i => data[i] };
}
const context = { createBuffer: (channels, length, rate) => audio(Array.from({ length: channels }, () => Array(length).fill(0)), rate) };

test('a selected round cap permits exactly that many playable questions', () => {
  const game = new GameSession(2, 100); game.add({id:'one'}); assert.equal(game.atLimit, false);
  game.add({id:'two'}); assert.equal(game.atLimit, true); assert.throws(() => game.add({id:'three'}));
  assert.equal(game.summary().remaining, 0); assert.equal(game.summary().played, 2);
});
test('regrading never adds duplicate points and unmarked questions count as zero', () => {
  const game = new GameSession(3, 3); for (const id of ['one','two','three']) game.add({id});
  game.grade(0, true); game.grade(0, true); game.grade(1, true); game.grade(1, false);
  assert.deepEqual(game.finish(), {played:3,correct:1,incorrect:1,unscored:1,score:1,target:3,requested:3,remaining:0,accuracy:33});
  game.grade(2, true); assert.equal(game.summary().score, 2); assert.throws(() => game.add({id:'four'}));
});
test('short playlists cap the actual rounds and exhaustion reports only played questions', () => {
  const short = new GameSession(10, 3); assert.equal(short.target, 3); assert.equal(short.requested, 10);
  const game = new GameSession(5, 20); game.add({id:'one'}); game.grade(0,true); game.finish('exhausted');
  assert.equal(game.reason, 'exhausted'); assert.equal(game.summary().played, 1); assert.equal(game.summary().score,1); assert.equal(game.summary().target,5);
});
test('round counts must be whole numbers from 1 to 100 and a new session clears results', () => {
  for (const value of [0,-1,101,1.5,NaN,Infinity,'5']) assert.throws(() => new GameSession(value,10));
  const game = new GameSession(1, 10); game.add({id:'one'}); game.grade(0,true); game.finish();
  const next = new GameSession(5,10); assert.equal(next.summary().score,0); assert.equal(next.records.length,0); assert.equal(next.finished,false);
});

test('reverses the chosen samples of every channel and preserves the original', () => {
  const original = audio([[1,2,3,4,5], [-1,-2,-3,-4,-5]]);
  const clips = makeClips(context, original, { start: 1, length: 3 });
  assert.deepEqual([...clips.reverse.getChannelData(0)], [4,3,2]);
  assert.deepEqual([...clips.reverse.getChannelData(1)], [-4,-3,-2]);
  assert.deepEqual([...clips.forward.getChannelData(0)], [2,3,4]);
  assert.deepEqual([...original.getChannelData(0)], [1,2,3,4,5]);
  assert.equal(clips.duration, .3); assert.equal(clips.start, .1);
});
test('short songs are bounded to their actual sample count', () => {
  assert.deepEqual(clipWindow(audio([[1,2,3]]), 30, 'random'), { start: 0, length: 3 });
  assert.deepEqual(clipWindow(audio([Array(100).fill(.5)]), 2, 'middle'), { start: 40, length: 20 });
  assert.deepEqual(clipWindow(audio([Array(100).fill(.5)]), 2, 'intro'), { start: 0, length: 20 });
});
test('random excerpts avoid a silent window when an audible window is sampled', () => {
  const samples = [...Array(50).fill(0), ...Array(50).fill(.5)]; let call = 0;
  const result = clipWindow(audio([samples]), 2, 'random', () => call++ === 0 ? 0 : .9);
  assert.ok(result.start >= 50 && result.start + result.length <= 100);
});
test('a whole round draws each track once, skips unavailable tracks, and resets', () => {
  const tracks = Array.from({ length: 100 }, (_, i) => ({ id: String(i) })); const deck = new Deck(tracks);
  deck.skip(['3', '7']); const drawn = [];
  while (deck.queue.length) drawn.push(deck.take(deck.queue[0].id).id);
  assert.equal(new Set(drawn).size, 98); assert.equal(deck.take(drawn[0]), null);
  assert.ok(!drawn.includes('3')); assert.equal(tracks.length, 100);
  deck.reset(); assert.equal(deck.queue.length, 100); assert.equal(deck.drawn.length, 0); assert.equal(deck.failed.size, 0);
});
test('shuffle does not mutate input and can reach both permutations', () => {
  const input = ['a', 'b']; assert.deepEqual(shuffle(input, () => 0), ['b', 'a']); assert.deepEqual(shuffle(input, () => .99), ['a','b']); assert.deepEqual(input, ['a','b']);
});
test('local files match IDs or exact normalized metadata without guessing between duplicate titles', () => {
  const tracks = [{ id:'123456', title:'夜 曲', artist:'歌手 A' }, { id:'987654', title:'夜 曲', artist:'歌手 B' }];
  assert.equal(localMatches({ name:'123456.mp3' }, tracks)[0].id, '123456');
  assert.equal(localMatches({ name:'歌手 A - 夜 曲.flac' }, tracks)[0].id, '123456');
  assert.equal(localMatches({ name:'夜曲.mp3' }, tracks).length, 2);
  assert.equal(localMatches({ name:'完全不同的歌.mp3' }, tracks).length, 0);
  assert.deepEqual(filenameInfo('艺术家 - 一首歌 - Live.mp3'), { artist:'艺术家', title:'一首歌 - Live' });
});
