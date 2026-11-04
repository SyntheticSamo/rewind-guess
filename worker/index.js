// Build embeds the browser files here. The same Worker runs locally through serve.mjs.
const ASSETS = {}; // BUILD_ASSETS
const ORIGIN = 'https://music.163.com';
const MAX_TRACKS = 5000;
const MAX_AUDIO = 40 * 1024 * 1024;
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: ORIGIN + '/' };

class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.status = status; this.code = code;
  }
}

export function validId(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,17}$/.test(id)) throw new AppError('请输入有效的网易云歌单或歌曲 ID。');
  return id;
}

export function allowedShareHost(host) {
  return host === 'music.163.com' || host === 'y.music.163.com' || host === '163cn.tv' || host === '163cn.link';
}

export function parsePlaylistInput(input) {
  const text = String(input || '').trim();
  if (!text || text.length > 3000) throw new AppError('请粘贴网易云歌单链接、分享文字或歌单 ID。');
  if (/^\d+$/.test(text)) return { id: validId(text) };
  const links = text.match(/https?:\/\/[^\s<>"，。）》]+/gi) || [];
  for (let link of links) {
    link = link.replace(/[)\]}>]+$/, '');
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!allowedShareHost(url.hostname) || url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) continue;
    url.protocol = 'https:'; url.port = '';
    if (url.hostname === '163cn.tv' || url.hostname === '163cn.link') return { shortUrl: url.href };
    const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), ORIGIN) : url;
    if (!/\/(?:m\/)?(?:share\/)?playlist(?:\/|$)/.test(route.pathname)) continue;
    const pathId = route.pathname.match(/\/playlist\/(\d+)/)?.[1];
    return { id: validId(route.searchParams.get('id') || pathId) };
  }
  throw new AppError('未找到网易云歌单链接。请在歌单页选择「分享 → 复制链接」，或输入歌单 ID。');
}

async function timedFetch(url, options = {}, milliseconds = 15000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(milliseconds) });
  } catch (error) {
    console.error('NetEase fetch failed', new URL(url).pathname, error?.name, error?.message);
    throw new AppError('连接网易云超时或网络不可达，请稍后重试，也可以使用本地音频。', 502, 'UPSTREAM_NETWORK');
  }
}

async function neteaseJson(path) {
  // Workers rejects redirect:"error" before sending the request; inspect redirects explicitly.
  const response = await timedFetch(ORIGIN + path, { headers: HEADERS, redirect: 'manual' });
  if (!response.ok) throw new AppError('网易云暂时拒绝了请求，请稍后再试。', 502, 'UPSTREAM_HTTP');
  let data;
  try { data = await response.json(); } catch { throw new AppError('网易云返回了无法识别的数据。', 502, 'UPSTREAM_DATA'); }
  if (data.code !== 200) throw new AppError('无法读取歌单或歌曲。请确认歌单公开、链接有效，且无需登录。', 422, 'UPSTREAM_RESTRICTED');
  return data;
}

async function resolvePlaylist(input) {
  let parsed = parsePlaylistInput(input);
  if (parsed.id) return parsed.id;
  let url = parsed.shortUrl;
  for (let i = 0; i < 6; i++) {
    const response = await timedFetch(url, { headers: HEADERS, redirect: 'manual' });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new AppError('无法解析这个短链接，请复制网易云网页版的完整歌单链接。', 422, 'SHORT_LINK');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || !allowedShareHost(next.hostname) || next.username || next.password || next.port) throw new AppError('歌单短链接跳转到了不支持的地址。');
    parsed = parsePlaylistInput(next.href);
    if (parsed.id) return parsed.id;
    url = next.href;
  }
  throw new AppError('短链接跳转过多，请使用完整歌单链接。');
}

function normalizeTrack(t) {
  return { id: String(t.id), title: String(t.name || '未命名歌曲'),
    artist: (t.ar || t.artists || []).map(a => a.name).filter(Boolean).join(' / ') || '未知歌手',
    duration: Math.max(0, Number(t.dt ?? t.duration ?? 0) / 1000), source: 'netease' };
}

async function getPlaylist(input) {
  const id = await resolvePlaylist(input);
  const data = await neteaseJson('/api/v6/playlist/detail?id=' + id + '&n=5000&s=0');
  const list = data.playlist || data.result;
  if (!list) throw new AppError('这张歌单暂时无法读取。', 422, 'PLAYLIST_EMPTY');
  const initial = list.tracks || [];
  const ids = [...new Set((list.trackIds || initial).map(t => validId(t.id)))];
  if (!ids.length) throw new AppError('这张歌单没有可读取的歌曲，或需要登录。', 422, 'PLAYLIST_EMPTY');
  if (ids.length > MAX_TRACKS) throw new AppError('当前支持最多 5000 首的歌单，请拆分歌单后导入。', 422, 'PLAYLIST_TOO_LARGE');
  const byId = new Map(initial.map(t => [String(t.id), t]));
  const missing = ids.filter(id => !byId.has(id));
  const batches = [];
  for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const detail = await neteaseJson('/api/song/detail?ids=' + encodeURIComponent(JSON.stringify(batch)));
      for (const track of detail.songs || []) byId.set(String(track.id), track);
    }
  }));
  const tracks = ids.map(id => byId.get(id)).filter(Boolean).map(normalizeTrack);
  if (!tracks.length) throw new AppError('未能读取歌曲详情，请稍后重试。', 502, 'UPSTREAM_DATA');
  const reportedTotal = Math.max(Number(list.trackCount) || 0, ids.length);
  return { id, name: String(list.name || '网易云歌单'), tracks, total: reportedTotal,
    missing: Math.max(0, reportedTotal - tracks.length), source: 'netease', url: ORIGIN + '/playlist?id=' + id };
}

async function getAudioEntries(ids) {
  const data = await neteaseJson('/api/song/enhance/player/url?ids=' + encodeURIComponent(JSON.stringify(ids)) + '&br=128000');
  return data.data || [];
}

export function allowedAudioUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('网易云未返回可用音频。', 422, 'AUDIO_UNAVAILABLE'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.music.126.net') || url.username || url.password || url.port) throw new AppError('网易云返回的音频地址不受支持。', 422, 'AUDIO_UNAVAILABLE');
  url.protocol = 'https:';
  return url;
}

async function audioResponse(id) {
  const entry = (await getAudioEntries([id])).find(t => String(t.id) === id);
  if (!entry?.url) throw new AppError('这首歌未返回可用音频，可能需要会员、登录或受地区限制。可以换一首或绑定本地音频。', 422, 'AUDIO_UNAVAILABLE');
  if (Number(entry.size) > MAX_AUDIO) throw new AppError('这首音频过大，请换一首或使用本地文件。', 422, 'AUDIO_TOO_LARGE');
  let url = allowedAudioUrl(entry.url);
  let response;
  for (let i = 0; i < 4; i++) {
    response = await timedFetch(url.href, { headers: HEADERS, redirect: 'manual' }, 25000);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    url = allowedAudioUrl(new URL(location || '', url).href);
  }
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !/^(audio\/|application\/octet-stream)/i.test(type)) {
    await response.body?.cancel();
    throw new AppError('未能取得歌曲音频，请换一首或绑定本地音频。', 422, 'AUDIO_UNAVAILABLE');
  }
  if (Number(response.headers.get('content-length')) > MAX_AUDIO) {
    await response.body?.cancel();
    throw new AppError('这首音频超过 40 MB，请使用本地文件。', 422, 'AUDIO_TOO_LARGE');
  }
  let size = 0;
  const stream = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    size += chunk.byteLength;
    if (size > MAX_AUDIO) { controller.error(new Error('音频超过 40 MB')); return; }
    controller.enqueue(chunk);
  } }));
  return new Response(stream, { headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-audio-trial': entry.freeTrialInfo ? 'true' : 'false' } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

async function bodyJson(request) {
  if (Number(request.headers.get('content-length')) > 10000) throw new AppError('请求内容过长。', 413);
  const text = await request.text();
  if (text.length > 10000) throw new AppError('请求内容过长。', 413);
  try { return JSON.parse(text); } catch { throw new AppError('请求内容格式不正确。'); }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/playlist' && request.method === 'POST') return json(await getPlaylist((await bodyJson(request)).input));
      if (url.pathname === '/api/check' && request.method === 'POST') {
        const { ids } = await bodyJson(request);
        if (!Array.isArray(ids) || !ids.length || ids.length > 20) throw new AppError('每次可检查 1–20 首歌曲。');
        const valid = [...new Set(ids.map(validId))];
        const entries = await getAudioEntries(valid);
        if (valid.some(id => !entries.some(t => String(t.id) === id))) throw new AppError('音源检查不完整，请重试。', 502, 'UPSTREAM_DATA');
        return json({ available: entries.filter(t => t.url).map(t => String(t.id)), unavailable: entries.filter(t => !t.url).map(t => String(t.id)) });
      }
      if (url.pathname === '/api/audio' && request.method === 'GET') return await audioResponse(validId(url.searchParams.get('id')));
      return json({ error: '接口不存在或请求方法不受支持。' }, 404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const asset = ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
      'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    } });
  } catch (error) {
    if (!(error instanceof AppError)) console.error('Rewind request failed:', error?.message);
    return json({ error: error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试。', code: error.code || 'SERVER_ERROR' }, error.status || 500);
  }
}

export default { async fetch(request, env = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return handleRequest(request);
  const origin = request.headers.get('origin');
  const allowed = origin === url.origin || (typeof env.PAGES_ORIGIN === 'string' && origin === env.PAGES_ORIGIN);
  if (origin && !allowed) return json({ error: '请从工具页面发起请求。' }, 403);
  let response;
  if (request.method === 'OPTIONS') {
    const method = request.headers.get('access-control-request-method');
    const requestedHeaders = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || !['GET', 'POST'].includes(method) || requestedHeaders.some(name => name !== 'content-type')) return json({ error: '不支持这个跨域请求。' }, 403);
    response = new Response(null, { status: 204 });
  } else response = await handleRequest(request);
  const headers = new Headers(response.headers); headers.set('vary', 'Origin');
  if (origin && allowed) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    headers.set('access-control-allow-headers', 'Content-Type');
    headers.set('access-control-expose-headers', 'X-Audio-Trial');
    headers.set('access-control-max-age', '600');
  }
  return new Response(response.body, { status: response.status, headers });
} };
