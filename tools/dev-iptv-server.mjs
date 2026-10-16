#!/usr/bin/env node
// A pretend IPTV provider for trying the app without a real subscription.
//
//   node tools/dev-iptv-server.mjs [port]          (default 8090; needs ffmpeg on PATH)
//
// It is an Xtream Codes panel (server http://<this PC>:8090, username "test", password "test"),
// an M3U playlist (http://<this PC>:8090/playlist.m3u) and an XMLTV guide (/xmltv.php). The live
// channels are made by ffmpeg in real time as they are watched, in the formats that trip up a
// browser and that VLC is there for: H.264 with AC3 audio, 1080i, MPEG-2 SD with MP2, HEVC with
// E-AC3, and a radio channel with no picture. The one film is an MKV with two audio languages and
// a subtitle track. It also serves web/ at /, for looking at the pages in a browser.
//
// The Xbox app reaches it over the network: allow Node through the Windows firewall when asked,
// and use this PC's address (printed at start) as the server. The app on this PC itself can only
// reach it if loopback is allowed for the app, which a Debug deploy from Visual Studio does.

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2]) || 8090;
const USER = 'test';
const PASS = 'test';
const WEB_ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const CACHE = join(tmpdir(), 'iptv-uwp-dev');
const FONT = "C\\:/Windows/Fonts/arial.ttf";

const CATEGORIES = [
  { category_id: '1', category_name: 'Test channels' },
  { category_id: '2', category_name: 'Radio' },
];

// Each channel is an ffmpeg recipe producing endless MPEG-TS.
const CHANNELS = [
  {
    id: 101, name: 'Test HD (H.264 + AC3)', category: '1', colour: '0x1e6fd9',
    video: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
    codecs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '3M',
      '-c:a', 'ac3', '-b:a', '192k'],
  },
  {
    id: 102, name: 'Sports 1080i (interlaced)', category: '1', colour: '0x2e9e44',
    video: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000'],
    codecs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '6M',
      '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-c:a', 'aac', '-b:a', '128k'],
  },
  {
    id: 103, name: 'Classic SD (MPEG-2 + MP2)', category: '1', colour: '0xc0392b',
    video: ['-f', 'lavfi', '-i', 'smptebars=size=720x576:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000'],
    codecs: ['-c:v', 'mpeg2video', '-b:v', '4M', '-g', '12', '-c:a', 'mp2', '-b:a', '192k'],
  },
  {
    id: 104, name: 'Movies HEVC (H.265 + E-AC3)', category: '1', colour: '0x8e44ad',
    video: ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000'],
    codecs: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error:keyint=50',
      '-b:v', '2M', '-c:a', 'eac3', '-b:a', '192k'],
  },
  // The same picture encoded as HDR: if VLC converts it for the screen it looks like the other
  // channels; if not, it looks washed out and grey.
  {
    id: 106, name: 'HDR10 test (HEVC 10-bit PQ)', category: '1', colour: '0xd35400',
    video: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000'],
    hdr: 'smpte2084',
    codecs: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'log-level=error:keyint=50:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:' +
        'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      '-b:v', '3M', '-c:a', 'aac', '-b:a', '128k'],
  },
  {
    id: 107, name: 'HLG test (HEVC 10-bit HLG)', category: '1', colour: '0x16a085',
    video: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25'],
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=580:sample_rate=48000'],
    hdr: 'arib-std-b67',
    codecs: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'log-level=error:keyint=50:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
      '-b:v', '3M', '-c:a', 'aac', '-b:a', '128k'],
  },
  {
    id: 105, name: 'Test Radio (audio only)', category: '2', colour: '0x555555',
    video: null,
    audio: ['-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:beep_factor=4'],
    codecs: ['-c:a', 'mp2', '-b:a', '192k'],
  },
];

const FILM = { id: 1001, name: 'Test Film (2 audio languages, subtitles)', category: '10', ext: 'mkv', seconds: 300 };

// ── Test content ────────────────────────────────────────────────────────────────

function filmPath() {
  return join(CACHE, 'test-film-stereo.mkv');
}

// The film is made once: five minutes of picture, an English and a French audio track (different
// tones) and English subtitles, so audio and subtitle switching can be tried.
function ensureFilm() {
  const out = filmPath();
  if (existsSync(out)) return;
  mkdirSync(CACHE, { recursive: true });
  const srt = join(CACHE, 'test-film.srt');
  let cues = '';
  for (let i = 0; i < FILM.seconds / 5; i++) {
    const start = i * 5;
    cues += `${i + 1}\n${stamp(start)} --> ${stamp(start + 4)}\nSubtitle number ${i + 1}, at ${start} seconds\n\n`;
  }
  writeFileSync(srt, cues);
  console.log('Making the test film (once)...');
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${FILM.seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${FILM.seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${FILM.seconds}`,
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-vf', `drawtext=fontfile='${FONT}':text='Test film  %{pts\\:hms}':fontsize=44:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a:0', 'ac3', '-b:a:0', '192k', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
    '-metadata:s:a:1', 'language=fre', '-metadata:s:a:1', 'title=Français',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
    out,
  ], { stdio: 'inherit' });
  if (result.status !== 0) console.error('Making the test film failed; the film will not play.');
}

function stamp(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s},000`;
}

// ── Guide ──────────────────────────────────────────────────────────────────────

// Half-hour programmes, named after the channel and the time, from two hours ago to a day ahead.
function programmes(channel) {
  const slot = 30 * 60;
  const first = Math.floor(Date.now() / 1000 / slot) * slot - 4 * slot;
  const list = [];
  for (let i = 0; i < 52; i++) {
    const start = first + i * slot;
    const at = new Date(start * 1000).toISOString().slice(11, 16);
    list.push({
      start, end: start + slot,
      title: `${channel.name.split(' (')[0]} at ${at}`,
      desc: `A made-up programme on ${channel.name}, from tools/dev-iptv-server.mjs.`,
    });
  }
  return list;
}

function xmltvTime(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
}

function xmltv() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="dev-iptv-server">\n';
  for (const ch of CHANNELS) {
    xml += `  <channel id="ch${ch.id}"><display-name>${esc(ch.name)}</display-name></channel>\n`;
  }
  for (const ch of CHANNELS) {
    for (const p of programmes(ch)) {
      xml += `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="ch${ch.id}">` +
        `<title>${esc(p.title)}</title><desc>${esc(p.desc)}</desc></programme>\n`;
    }
  }
  return xml + '</tv>\n';
}

// ── Xtream API ─────────────────────────────────────────────────────────────────

function logo(channel) {
  const colour = '#' + channel.colour.slice(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="16" fill="${colour}"/>` +
    `<text x="48" y="60" font-family="Arial" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${channel.id}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function api(params, host) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (s) => Buffer.from(s).toString('base64');
  switch (params.get('action')) {
    case null:
    case '':
      return {
        user_info: {
          username: USER, password: PASS, auth: 1, status: 'Active', exp_date: null, is_trial: '0',
          active_cons: '0', created_at: String(now - 86400), max_connections: '2', allowed_output_formats: ['m3u8', 'ts'],
        },
        server_info: {
          url: host.split(':')[0], port: String(PORT), https_port: '', server_protocol: 'http', rtmp_port: '',
          timezone: 'UTC', timestamp_now: now, time_now: new Date().toISOString().replace('T', ' ').slice(0, 19),
        },
      };
    case 'get_live_categories':
      return CATEGORIES.map((c) => ({ ...c, parent_id: 0 }));
    case 'get_live_streams':
      return CHANNELS
        .filter((ch) => !params.get('category_id') || params.get('category_id') === ch.category)
        .map((ch, i) => ({
          num: i + 1, name: ch.name, stream_type: 'live', stream_id: ch.id, stream_icon: logo(ch),
          epg_channel_id: `ch${ch.id}`, added: String(now - 86400), category_id: ch.category, custom_sid: '',
          tv_archive: 0, direct_source: '', tv_archive_duration: 0,
        }));
    case 'get_short_epg':
    case 'get_simple_data_table': {
      const ch = CHANNELS.find((c) => String(c.id) === params.get('stream_id'));
      if (!ch) return { epg_listings: [] };
      const limit = Number(params.get('limit')) || 4;
      const list = programmes(ch).filter((p) => p.end > now);
      return {
        epg_listings: list.slice(0, limit).map((p, i) => ({
          id: String(p.start), epg_id: `ch${ch.id}`, title: b64(p.title), description: b64(p.desc), lang: 'en',
          start: new Date(p.start * 1000).toISOString().replace('T', ' ').slice(0, 19),
          end: new Date(p.end * 1000).toISOString().replace('T', ' ').slice(0, 19),
          start_timestamp: String(p.start), stop_timestamp: String(p.end), now_playing: i === 0 ? 1 : 0, has_archive: 0,
        })),
      };
    }
    case 'get_vod_categories':
      return [{ category_id: FILM.category, category_name: 'Test films', parent_id: 0 }];
    case 'get_vod_streams':
      if (params.get('category_id') && params.get('category_id') !== FILM.category) return [];
      return [{
        num: 1, name: FILM.name, stream_type: 'movie', stream_id: FILM.id, stream_icon: '', rating: '7.5', rating_5based: 3.8,
        added: String(now - 3600), category_id: FILM.category, container_extension: FILM.ext, custom_sid: '', direct_source: '',
      }];
    case 'get_vod_info':
      return {
        info: {
          name: FILM.name, plot: 'Five minutes of test pattern with English and French audio and English subtitles.',
          genre: 'Test', duration_secs: FILM.seconds, duration: '00:05:00', releasedate: '2026-01-01', rating: '7.5',
          movie_image: '', cover_big: '',
        },
        movie_data: { stream_id: FILM.id, name: FILM.name, added: String(now - 3600), category_id: FILM.category, container_extension: FILM.ext },
      };
    case 'get_series_categories':
    case 'get_series':
      return [];
    default:
      return [];
  }
}

function m3u(host) {
  let out = `#EXTM3U url-tvg="http://${host}/xmltv.php"\n`;
  for (const ch of CHANNELS) {
    const group = CATEGORIES.find((c) => c.category_id === ch.category).category_name;
    out += `#EXTINF:-1 tvg-id="ch${ch.id}" tvg-name="${ch.name}" tvg-logo="${logo(ch)}" group-title="${group}",${ch.name}\n`;
    out += `http://${host}/live/${USER}/${PASS}/${ch.id}.ts\n`;
  }
  return out;
}

// ── Streams ────────────────────────────────────────────────────────────────────

function streamLive(channel, req, res) {
  const args = ['-hide_banner', '-loglevel', 'error', '-re'];
  if (channel.video) args.push(...channel.video);
  args.push(...channel.audio);
  if (channel.video) {
    args.push('-vf', `drawtext=fontfile='${FONT}':text='${channel.name.replace(/[':,]/g, ' ')}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40,` +
      `drawtext=fontfile='${FONT}':text='%{localtime}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=100` +
      // HDR channels: the SDR picture converted properly (SDR white at 100 nits), not just relabelled.
      (channel.hdr ? `,format=yuv420p,zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:t=${channel.hdr}:p=bt2020:m=bt2020nc:r=tv:npl=100,format=yuv420p10le` : ''));
  }
  args.push(...channel.codecs, '-ac', '2', '-f', 'mpegts', '-mpegts_service_id', String(channel.id), 'pipe:1');
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`live ${channel.id} started for ${req.socket.remoteAddress}`);
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  const stop = () => { if (ff.exitCode === null) ff.kill('SIGKILL'); };
  req.on('close', () => { stop(); console.log(`live ${channel.id} stopped`); });
  ff.on('exit', () => res.end());
}

function serveFile(path, req, res, type) {
  let size;
  try { size = statSync(path).size; } catch { res.writeHead(404).end(); return; }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(path).pipe(res);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveWeb(pathname, req, res) {
  const path = normalize(join(WEB_ROOT, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
  if (!path.startsWith(WEB_ROOT + sep) && path !== WEB_ROOT) { res.writeHead(403).end(); return; }
  serveFile(path, req, res, TYPES[extname(path).toLowerCase()] || 'application/octet-stream');
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const host = req.headers.host || `localhost:${PORT}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  const authed = url.searchParams.get('username') === USER && url.searchParams.get('password') === PASS;
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const path = url.pathname;
  console.log(req.method, path + (url.searchParams.get('action') ? ' ' + url.searchParams.get('action') : ''));

  if (path === '/player_api.php') {
    if (!authed) return json({ user_info: { auth: 0 } });
    return json(api(url.searchParams, host));
  }
  if (path === '/xmltv.php' || path === '/epg.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(xmltv());
  }
  if (path === '/playlist.m3u' || path === '/get.php') {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8' });
    return res.end(m3u(host));
  }
  const live = /^\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)\.(ts|m3u8)$/.exec(path);
  if (live) {
    const channel = CHANNELS.find((c) => String(c.id) === live[3]);
    if (live[1] !== USER || live[2] !== PASS || !channel) return res.writeHead(404).end();
    // Only raw MPEG-TS here; the app tries .ts first for Xtream live channels.
    if (live[4] === 'm3u8') return res.writeHead(404).end();
    return streamLive(channel, req, res);
  }
  const movie = /^\/movie\/([^/]+)\/([^/]+)\/(\d+)\.\w+$/.exec(path);
  if (movie) {
    if (movie[1] !== USER || movie[2] !== PASS || movie[3] !== String(FILM.id)) return res.writeHead(404).end();
    return serveFile(filmPath(), req, res, 'video/x-matroska');
  }
  return serveWeb(path, req, res);
});

ensureFilm();
server.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Pretend IPTV provider on port ${PORT}`);
  for (const a of ['localhost', ...addresses]) {
    console.log(`  Xtream: server http://${a}:${PORT}  username ${USER}  password ${PASS}`);
  }
  console.log(`  M3U:    http://${addresses[0] || 'localhost'}:${PORT}/playlist.m3u   guide /xmltv.php`);
});
