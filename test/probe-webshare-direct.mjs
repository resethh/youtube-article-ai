// 直连 webshare（单层代理）→ CONNECT www.youtube.com → TLS 握手
// 与 probe-captions.mjs 经由 Clash 双层不同，此脚本直接连 webshare，验证 webshare 隧道内 TLS 是否可握手
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const proxy = { host: process.argv[2] || '45.38.107.97', port: Number(process.argv[3] || 6014), user: 'gjdrhtzn', pass: 'hdd8qs39pgvy' };
const host = 'www.youtube.com';

const sock = connect({ host: proxy.host, port: proxy.port, timeout: 15000 });
await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); sock.once('timeout', () => rej(new Error('tcp timeout'))); });
console.log('TCP connect ok ->', proxy.host + ':' + proxy.port);

const auth = 'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`);

let buf = Buffer.alloc(0);
let leftover = Buffer.alloc(0);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('connect head timeout')), 15000);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx >= 0) {
      leftover = buf.subarray(idx + 4);
      buf = buf.subarray(0, idx + 4);
      clearTimeout(t);
      sock.pause();
      res();
    }
  };
  sock.on('data', onData);
  sock.on('error', rej);
});
sock.removeAllListeners('data');
const headLine = buf.toString().split('\r\n')[0];
console.log('CONNECT head:', headLine);
if (!/HTTP\/1\.[01] 200\b/.test(headLine)) { console.log('CONNECT FAILED'); process.exit(1); }
if (leftover.length) console.log('leftover after head:', leftover.length, 'bytes');

const tls = tlsConnect({ socket: sock, servername: host });
try {
  await new Promise((res, rej) => { tls.once('secureConnect', res); tls.once('error', (e) => rej(e)); });
  console.log('TLS handshake OK');
  tls.write('GET /robots.txt HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n');
  let raw = leftover ? Buffer.from(leftover) : Buffer.alloc(0);
  await new Promise((res) => {
    const t = setTimeout(res, 15000);
    tls.on('data', (d) => { raw = Buffer.concat([raw, d]); });
    tls.on('end', res);
    tls.on('close', res);
    tls.on('error', () => {});
  });
  console.log('response:', raw.length, 'bytes; first line:', raw.slice(0, 80).toString().split('\r\n')[0]);
} catch (e) {
  console.log('TLS handshake FAILED:', e.message);
  process.exit(1);
}
process.exit(0);