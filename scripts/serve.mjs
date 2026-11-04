import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import './build.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { default: worker } = await import(pathToFileURL(resolve(root, 'dist/server/index.js')).href);
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on('close', () => controller.abort());
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request('http://' + (incoming.headers.host || host + ':' + port) + incoming.url, {
      method: incoming.method, headers, signal: controller.signal,
      ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
    });
    const response = await worker.fetch(request, {}, {});
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const stream = Readable.fromWeb(response.body);
      stream.on('error', () => outgoing.destroy());
      outgoing.on('close', () => stream.destroy());
      stream.pipe(outgoing);
    } else outgoing.end();
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end('服务暂时不可用。'); console.error(error.message);
  }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口 ' + port + ' 已被使用。请关闭之前启动的倒带窗口，或设置 PORT 环境变量。' : error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  const url = 'http://' + host + ':' + port;
  console.log('倒带已启动：' + url + '\n保持此窗口开启，按 Ctrl+C 停止。');
  if (process.argv.includes('--open')) {
    const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => console.log('请在浏览器中打开上方地址。')); child.unref();
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
