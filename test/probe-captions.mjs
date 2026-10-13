// 通过本地 Clash 直测 YouTube 字幕链路（验证 baoyu 指纹移植是否有效）
// 用法: node probe-captions.mjs <videoId>
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const CLASH = { host: '127.0.0.1', port: 7897 };
const videoId = process.argv[2] || 'xRh2sVcNXQ8';

const WATCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

async function httpViaClash(host, path, { method = 'GET', headers = {}, body: postBody } = {}) {
  const sock = connect({ host: CLASH.host, port: CLASH.port });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });

  // CONNECT 隧道：只读 head，多余字节留给 TLS（用 leftover 变量保存）
  sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
  let buf = Buffer.alloc(0);
  let leftover = Buffer.alloc(0);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CONNECT header timeout')), 10000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) {
        leftover = buf.subarray(idx + 4);
        buf = buf.subarray(0, idx + 4);
        clearTimeout(timer);
        sock.pause();
        res();
      }
    };
    sock.on('data', onData);
    sock.on('error', rej);
  });
  sock.removeAllListeners('data');
  if (!/^HTTP\/1\.[01] 200\b/.test(buf.toString())) {
    sock.destroy();
    throw new Error('Clash CONNECT failed: ' + buf.toString().split('\r\n')[0]);
  }

  // TLS 升级
  const tls = tlsConnect({ socket: sock, servername: host });
  await new Promise((res, rej) => { tls.once('secureConnect', res); tls.once('error', rej); });

  const req = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    postBody || '',
  ].join('\r\n');
  tls.write(req);

  let raw = Buffer.alloc(0);
  if (leftover.length) raw = Buffer.concat([raw, leftover]);
  await new Promise((res, rej) => {
    tls.on('data', (d) => { raw = Buffer.concat([raw, d]); });
    tls.on('end', res);
    tls.on('close', res);
    tls.on('error', rej);
    setTimeout(res, 20000);
  });

  const idx = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, idx).toString();
  const bodyBuf = raw.slice(idx + 4);
  const status = parseInt(head.split(' ')[1], 10);
  // 简单解 chunked
  let body = bodyBuf.toString();
  if (head.toLowerCase().includes('transfer-encoding: chunked')) {
    body = decodeChunked(bodyBuf).toString();
  }
  return { status, body };
}

function decodeChunked(buf) {
  const chunks = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(buf.slice(pos, lineEnd).toString(), 16);
    if (!size) break;
    chunks.push(buf.slice(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(chunks);
}

async function main() {
  // 1. 抓 watch 页
  console.log(`\n== 1. watch page ${videoId} ==`);
  const watch = await httpViaClash('www.youtube.com', `/watch?v=${videoId}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`, {
    headers: { 'User-Agent': WATCH_UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const apiKey = watch.body.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  const visitorData = watch.body.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || watch.body.match(/"visitorData":"([^"]+)"/)?.[1] || '';
  const webVer = watch.body.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1] || '';
  console.log(`watch status=${watch.status} len=${watch.body.length}`);
  console.log(`apiKey=${apiKey ? apiKey.slice(0, 20) + '...' : 'MISSING'}`);
  console.log(`visitorData=${visitorData ? 'yes(' + visitorData.slice(0, 20) + '...)' : 'NO'}`);
  console.log(`webClientVersion=${webVer}`);
  if (!apiKey) { console.log('HTML snippet:', watch.body.replace(/\s+/g, ' ').slice(0, 300)); return; }

  const clients = [
    { name: 'ANDROID', ver: '20.10.38', header: '3', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/AP1A.240405.002)' },
    { name: 'WEB', ver: webVer || '2.20260320.08.00', header: '1', ua: WATCH_UA },
    { name: 'IOS', ver: '20.10.4', header: '5', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X; en_US)' },
  ];

  for (const c of clients) {
    console.log(`\n== 2. player via ${c.name} ${c.ver} ==`);
    const ctx = {
      context: {
        client: { hl: 'en', gl: 'US', visitorData, clientName: c.name, clientVersion: c.ver, ...(c.name === 'ANDROID' ? { clientFormFactor: 'SMALL_FORM_FACTOR', androidSdkVersion: 34, osName: 'Android', osVersion: '14', platform: 'MOBILE' } : {}), ...(c.name === 'IOS' ? { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.0.22D5054f', platform: 'MOBILE' } : {}) },
        request: { useSsl: true },
      },
      videoId,
    };
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      'User-Agent': c.ua,
      'X-YouTube-Client-Name': c.header,
      'X-YouTube-Client-Version': c.ver,
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    const player = await httpViaClash('www.youtube.com', `/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
      method: 'POST', headers, body: JSON.stringify(ctx),
    });
    let json;
    try { json = JSON.parse(player.body); } catch { json = null; }
    const ps = json?.playabilityStatus?.status ?? 'PARSE_FAIL';
    const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.log(`status=${player.status} playability=${ps} tracks=${tracks.length}`);
    if (tracks.length) {
      const t = tracks.find(x => x.languageCode === 'en' && x.baseUrl?.includes('kind=asr')) || tracks[0];
      console.log(`  track lang=${t.languageCode} asr=${t.baseUrl?.includes('kind=asr')} baseUrl=${t.baseUrl?.slice(0, 80)}...`);

      // 3. timedtext
      const ttUrl = new URL(t.baseUrl);
      ttUrl.searchParams.set('fmt', 'json3');
      const tt = await httpViaClash('www.youtube.com', `${ttUrl.pathname}${ttUrl.search}`, { headers: { 'User-Agent': c.ua, 'Accept-Language': 'en-US,en;q=0.9' } });
      let segs = 0;
      try { segs = JSON.parse(tt.body).events?.length ?? 0; } catch {}
      console.log(`timedtext status=${tt.status} segments=${segs}`);
    }
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });