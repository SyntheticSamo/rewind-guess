import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { parsePlaylistInput, allowedAudioUrl } from '../worker/index.js';

test('accepts desktop, hash, mobile, path IDs and copied Markdown playlist links', () => {
  for (const input of ['2452479860', 'https://music.163.com/playlist?id=2452479860', 'https://music.163.com/#/playlist?id=2452479860', '分享歌单 https://y.music.163.com/m/playlist?id=2452479860&userid=1', '[我的歌单](https://music.163.com/playlist?id=2452479860)', 'https://music.163.com/playlist/2452479860']) assert.equal(parsePlaylistInput(input).id, '2452479860');
  assert.ok(parsePlaylistInput('https://163cn.tv/abcd').shortUrl);
});
test('rejects other sites, song links, credentials, local addresses and malformed IDs', () => {
  for (const input of ['', '-1', '1&injected=true', 'https://evil.example/playlist?id=1', 'https://music.163.com.evil.example/playlist?id=1', 'https://music.163.com/song?id=1', 'http://127.0.0.1/playlist?id=1', 'https://u:p@music.163.com/playlist?id=1', 'https://music.163.com:9999/playlist?id=1']) assert.throws(() => parsePlaylistInput(input));
});
test('only permits music CDN audio URLs and upgrades HTTP', () => {
  assert.equal(allowedAudioUrl('http://m801.music.126.net/test.mp3').protocol, 'https:');
  for (const url of ['https://127.0.0.1/file', 'https://music.126.net.evil.example/file', 'file:///etc/passwd', 'https://u:p@m801.music.126.net/test']) assert.throws(() => allowedAudioUrl(url));
});

const request = (path, body) => new Request('https://rewind.example' + path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
test('configured Pages origin receives a preflight response without upstream access or credentials', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  const response = await worker.fetch(new Request('https://rewind.example/api/playlist', {method:'OPTIONS',headers:{origin:'https://player.github.io','access-control-request-method':'POST','access-control-request-headers':'content-type'}}), {PAGES_ORIGIN:'https://player.github.io'});
  assert.equal(response.status,204); assert.equal(response.headers.get('access-control-allow-origin'),'https://player.github.io');
  assert.equal(response.headers.get('access-control-allow-credentials'),null); assert.equal(response.headers.get('vary'),'Origin'); assert.equal(mocked.mock.callCount(),0);
});
test('configured Pages frontend receives CORS headers on success and readable API errors', async t => {
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:200,data:[{id:1,url:null}]}));
  const headers={origin:'https://player.github.io','content-type':'application/json'};
  let response=await worker.fetch(new Request('https://rewind.example/api/check',{method:'POST',headers,body:JSON.stringify({ids:['1']})}),{PAGES_ORIGIN:'https://player.github.io'});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),headers.origin);assert.deepEqual(await response.json(),{available:[],unavailable:['1']});
  response=await worker.fetch(new Request('https://rewind.example/api/audio?id=1',{headers}),{PAGES_ORIGIN:'https://player.github.io'});
  assert.equal(response.status,422);assert.equal(response.headers.get('access-control-allow-origin'),headers.origin);assert.equal(response.headers.get('access-control-expose-headers'),'X-Audio-Trial');assert.equal((await response.json()).code,'AUDIO_UNAVAILABLE');
});
test('lookalike Pages origins and unexpected preflight headers are denied', async t => {
  const mocked=t.mock.method(globalThis,'fetch',async()=>{throw new Error('must not fetch');});
  for(const origin of ['https://player.github.io.evil.example','https://other.github.io','null']) {
    const response=await worker.fetch(new Request('https://rewind.example/api/check',{method:'POST',headers:{origin},body:'{}'}),{PAGES_ORIGIN:'https://player.github.io'});
    assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
  }
  const response=await worker.fetch(new Request('https://rewind.example/api/check',{method:'OPTIONS',headers:{origin:'https://player.github.io','access-control-request-method':'POST','access-control-request-headers':'authorization'}}),{PAGES_ORIGIN:'https://player.github.io'});
  assert.equal(response.status,403);assert.equal(mocked.mock.callCount(),0);
});
test('playlist and audio checks work in Workers where redirect:error throws before network I/O', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
    assert.equal(options.redirect, 'manual');
    return Response.json(String(url).includes('/playlist/') ? {code:200,playlist:{name:'Worker list',trackCount:1,trackIds:[{id:1}],tracks:[{id:1,name:'Song'}]}} : {code:200,data:[{id:1,url:'https://m801.music.126.net/a.mp3'}]});
  });
  assert.equal((await worker.fetch(request('/api/playlist', {input:'123'}))).status, 200);
  assert.equal((await worker.fetch(request('/api/check', {ids:['1']}))).status, 200);
});
test('upstream redirects are rejected explicitly without following an arbitrary destination', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(null,{status:302,headers:{location:'https://evil.example/collect'}}));
  const response = await worker.fetch(request('/api/playlist',{input:'123'}));
  assert.equal(response.status,502); assert.equal((await response.json()).code,'UPSTREAM_HTTP'); assert.equal(mocked.mock.callCount(),1);
});
test('completes a partial playlist through batched song details without losing order', async t => {
  const ids = Array.from({ length: 225 }, (_, i) => i + 1000); const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url); calls.push(u);
    const songs = values => values.map(id => ({ id, name:'Track ' + id, artists:[{ name:'Artist' }], duration:120000 }));
    return Response.json(u.pathname.includes('/playlist/') ? { code:200, playlist:{ name:'Real list', trackCount:225, trackIds:ids.map(id=>({id})), tracks:songs(ids.slice(0,6)) } } : { code:200, songs:songs(JSON.parse(u.searchParams.get('ids'))) });
  });
  const response = await worker.fetch(request('/api/playlist', {input:'2452479860'})); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.tracks.length, 225); assert.equal(data.missing, 0);
  assert.deepEqual(data.tracks.map(t=>t.id), ids.map(String)); assert.equal(data.tracks[224].duration, 120); assert.equal(calls.length, 4);
});
test('reports missing track descriptions instead of silently claiming completeness', async t => {
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/playlist/') ? { code:200, playlist:{ name:'Partial', trackCount:4, trackIds:[{id:1},{id:2}], tracks:[{id:1,name:'One'}] } } : { code:200, songs:[] }));
  const data = await (await worker.fetch(request('/api/playlist', {input:'123'}))).json();
  assert.equal(data.total, 4); assert.equal(data.tracks.length, 1); assert.equal(data.missing, 3);
});
test('returns availability separately from playlist metadata', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({code:200,data:[{id:1,url:'https://m801.music.126.net/a.mp3'},{id:2,url:null}]}));
  const data = await (await worker.fetch(request('/api/check', {ids:['1','2']}))).json();
  assert.deepEqual(data, {available:['1'],unavailable:['2']});
});
test('incomplete upstream availability is an error, not proof a song is unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({code:200,data:[]}));
  const response = await worker.fetch(request('/api/check', {ids:['1']})); assert.equal(response.status, 502);
});
test('audio failures and upstream HTML return clear errors instead of corrupt audio', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({code:200,data:[{id:1,url:null}]}));
  let response = await worker.fetch(new Request('https://rewind.example/api/audio?id=1')); assert.equal(response.status, 422); assert.equal((await response.json()).code, 'AUDIO_UNAVAILABLE');
  globalThis.fetch = async url => String(url).includes('/api/') ? Response.json({code:200,data:[{id:1,url:'https://m801.music.126.net/a.mp3'}]}) : new Response('<html>login</html>', {headers:{'content-type':'text/html'}});
  response = await worker.fetch(new Request('https://rewind.example/api/audio?id=1')); assert.equal(response.status, 422);
});
test('streams real audio bytes and identifies a preview', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/api/') ? Response.json({code:200,data:[{id:1,url:'http://m801.music.126.net/a.mp3',freeTrialInfo:{start:0,end:30}}]}) : new Response(new Uint8Array([73,68,51,1,2,3]), {headers:{'content-type':'audio/mpeg'}}));
  const response = await worker.fetch(new Request('https://rewind.example/api/audio?id=1'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-audio-trial'), 'true'); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [73,68,51,1,2,3]);
});
test('rejects CDN redirects leaving the allowed host set', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/api/') ? Response.json({code:200,data:[{id:1,url:'https://m801.music.126.net/a.mp3'}]}) : new Response(null, {status:302,headers:{location:'https://127.0.0.1/private'}}));
  const response = await worker.fetch(new Request('https://rewind.example/api/audio?id=1')); assert.equal(response.status, 422);
});
test('rejects cross-origin API use and invalid JSON before calling NetEase', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not call upstream'); });
  assert.equal((await worker.fetch(new Request('https://rewind.example/api/playlist', {method:'POST',headers:{origin:'https://evil.example'},body:'{}'}))).status, 403);
  assert.equal((await worker.fetch(new Request('https://rewind.example/api/playlist', {method:'POST',body:'{'}))).status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);
});
