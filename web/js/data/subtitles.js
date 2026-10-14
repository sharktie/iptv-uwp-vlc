/* data/subtitles.js — works out what subtitles exist for a VOD title, and is
 * honest about the ones that exist but can't be used. Exposes window.Subs.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Xtream panels answer `get_vod_info` / `get_series_info` with a `subtitles`
 * field whose shape is entirely up to whoever built the panel. Five shapes turn
 * up in practice:
 *
 *   1. []                                                   nothing
 *   2. ["http://host/subs/en.srt", …]                       array of URLs
 *   3. [{ url|file|src|link|subtitle_file|path: "…" }, …]    array of objects
 *   4. { eng: "http://…", fre: "…" }                         language-keyed map
 *   5. [{ index: 2, codec_name: "subrip",
 *         codec_type: "subtitle",
 *         tags: { language: "eng" } }, …]                    ffprobe descriptors
 *
 * Shape 5 is by far the most common on the big panels, and it is the one that
 * caused the bug this file fixes. It does not describe files — it describes
 * subtitle STREAMS already muxed into the video. There is nothing to download.
 * The old code filtered for a URL, threw shape 5 away, and left the player
 * saying "No subtitles found for this title" about a file that demonstrably has
 * two of them. That is the worst possible answer: it is both wrong and a dead
 * end.
 *
 * So this module keeps both halves of the answer:
 *
 *   files     — subtitles that can be fetched and attached as <track>s
 *   embedded  — subtitles the panel says are inside the video, with their
 *               languages, which the player reports to the user along with the
 *               two things that actually work (the HLS tier, or OpenSubtitles)
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.Subs = (function () {
    'use strict';

    var DIAG_KEY = 'iptv_subs_diag';

    /* ── Language naming ──────────────────────────────────────────────────────
       Panels label tracks with anything from "English Forced" to "eng" to
       nothing. Map the ISO codes so a menu doesn't read as a list of
       three-letter codes. Shared with the player's own labelling. */
    var LANG_NAMES = {
        en: 'English',    eng: 'English',   und: 'Unknown',
        fr: 'French',     fre: 'French',    fra: 'French',
        de: 'German',     ger: 'German',    deu: 'German',
        es: 'Spanish',    spa: 'Spanish',
        it: 'Italian',    ita: 'Italian',
        pt: 'Portuguese', por: 'Portuguese',
        nl: 'Dutch',      dut: 'Dutch',     nld: 'Dutch',
        pl: 'Polish',     pol: 'Polish',
        ru: 'Russian',    rus: 'Russian',
        tr: 'Turkish',    tur: 'Turkish',
        ar: 'Arabic',     ara: 'Arabic',
        hi: 'Hindi',      hin: 'Hindi',
        ur: 'Urdu',       urd: 'Urdu',
        zh: 'Chinese',    chi: 'Chinese',   zho: 'Chinese',
        ja: 'Japanese',   jpn: 'Japanese',
        ko: 'Korean',     kor: 'Korean',
        sv: 'Swedish',    swe: 'Swedish',
        no: 'Norwegian',  nor: 'Norwegian',
        da: 'Danish',     dan: 'Danish',
        fi: 'Finnish',    fin: 'Finnish',
        el: 'Greek',      gre: 'Greek',     ell: 'Greek',
        he: 'Hebrew',     heb: 'Hebrew',
        ro: 'Romanian',   rum: 'Romanian',  ron: 'Romanian',
        cs: 'Czech',      cze: 'Czech',     ces: 'Czech',
        hu: 'Hungarian',  hun: 'Hungarian',
        bg: 'Bulgarian',  bul: 'Bulgarian',
        uk: 'Ukrainian',  ukr: 'Ukrainian'
    };

    function langName(code) {
        if (!code) return '';
        var c = String(code).toLowerCase().replace(/[_-].*$/, '');   // en-GB → en
        return LANG_NAMES[c] || String(code).toUpperCase();
    }

    /* ── Shape detection ──────────────────────────────────────────────────── */
    var URL_KEYS = ['url', 'file', 'src', 'link', 'subtitle_file', 'path', 'href'];

    function urlFrom(obj) {
        for (var i = 0; i < URL_KEYS.length; i++) {
            var v = obj[URL_KEYS[i]];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
    }

    function langFrom(obj) {
        return obj.lang || obj.language ||
               (obj.tags && (obj.tags.language || obj.tags.LANGUAGE)) ||
               '';
    }

    function titleFrom(obj) {
        return obj.title || obj.name || obj.label ||
               (obj.tags && (obj.tags.title || obj.tags.TITLE)) ||
               '';
    }

    /* An ffprobe stream descriptor: no URL, but it self-identifies with an
       index and/or a codec. Anything with neither a URL nor these markers is
       simply unusable and is counted as "unknown" rather than guessed at. */
    function looksEmbedded(obj) {
        if (obj.codec_type === 'subtitle') return true;
        if (obj.codec_name && obj.index !== undefined) return true;
        return obj.index !== undefined && !!(obj.tags || obj.codec_name);
    }

    /* Some panels return the whole `subtitles` value as a base64 or
       URL-encoded JSON string rather than as JSON. Unwrap one layer of that
       before giving up; anything deeper is not worth chasing. */
    function unwrapString(raw) {
        var s = String(raw).trim();
        if (!s) return null;
        if (/^https?:\/\//i.test(s) || /\.(srt|vtt|ass|ssa|sub)$/i.test(s)) return [s];
        if (s.charAt(0) === '[' || s.charAt(0) === '{') {
            try { return JSON.parse(s); } catch (e) {}
        }
        if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 8) {
            try {
                var decoded = atob(s.replace(/\s+/g, ''));
                if (decoded.charAt(0) === '[' || decoded.charAt(0) === '{') return JSON.parse(decoded);
                if (/^https?:\/\//i.test(decoded)) return [decoded];
            } catch (e) {}
        }
        return [s];
    }

    /* ── Core normaliser ──────────────────────────────────────────────────────
       Takes any of the five shapes and returns { files, embedded, unknown }.
       `cfg` is only needed to resolve relative paths against the IPTV server. */
    function parse(raw, cfg) {
        var out = { files: [], embedded: [], unknown: 0 };
        if (!raw) return out;

        var list;
        if (typeof raw === 'string')      list = unwrapString(raw);
        else if (isArray(raw))            list = raw;
        else if (typeof raw === 'object') {
            /* Language-keyed map: { eng: "…", fre: {…} } */
            list = [];
            for (var k in raw) {
                if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
                var v = raw[k];
                if (typeof v === 'string') list.push({ url: v, lang: k });
                else if (v && typeof v === 'object') {
                    if (!langFrom(v)) v.lang = k;
                    list.push(v);
                }
            }
        } else return out;

        if (!list || !isArray(list)) return out;

        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            if (typeof s === 'string') {
                var u = String(s).trim();
                if (u) out.files.push(makeFile(u, '', '', cfg));
                else out.unknown++;
                continue;
            }
            if (!s || typeof s !== 'object') { out.unknown++; continue; }

            var url = urlFrom(s);
            if (url) {
                out.files.push(makeFile(url, langFrom(s), titleFrom(s), cfg));
            } else if (looksEmbedded(s)) {
                var lang = langFrom(s);
                out.embedded.push({
                    index: s.index,
                    lang:  lang,
                    codec: s.codec_name || s.codec || '',
                    label: titleFrom(s) || langName(lang) || ('Track ' + (out.embedded.length + 1)),
                    forced: !!(s.disposition && s.disposition.forced)
                });
            } else {
                out.unknown++;
            }
        }
        return out;
    }

    function makeFile(url, lang, title, cfg) {
        var abs = (typeof Config !== 'undefined') ? Config.absUrl(cfg, url) : url;
        return {
            url:   abs,
            lang:  lang || guessLangFromUrl(abs),
            label: title || langName(lang || guessLangFromUrl(abs)) || 'Subtitles'
        };
    }

    /* Last resort when neither the panel nor the filename declares a language:
       "…/Inception.en.srt" or "…/subs_eng.srt" is a strong enough hint to
       label the entry with, and a wrong label is still better than five
       identical "Subtitles" rows. */
    function guessLangFromUrl(url) {
        var m = /[._-]([a-z]{2,3})\.(?:srt|vtt|ass|ssa|sub)$/i.exec(String(url || ''));
        return (m && LANG_NAMES[m[1].toLowerCase()]) ? m[1].toLowerCase() : '';
    }

    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    /* ── Panel payload entry points ───────────────────────────────────────────
       get_vod_info splits its payload across `info` and `movie_data`, and which
       one carries `subtitles` varies by panel — so merge across all three
       rather than short-circuiting on the first that exists. Merging (rather
       than picking one) matters because some panels put the files in one and
       the ffprobe streams in the other. */
    function fromVodInfo(data, cfg) {
        return merge([
            parse(pick(data && data.info), cfg),
            parse(pick(data && data.movie_data), cfg),
            parse(pick(data), cfg)
        ]);
    }

    function fromEpisode(ep, cfg) {
        return merge([
            parse(pick(ep && ep.info), cfg),
            parse(pick(ep), cfg)
        ]);
    }

    /* ── What the panel actually sent ─────────────────────────────────────────
       "No subtitles" out of a parser is two completely different facts: the
       panel listed none, or it listed some in a shape this code doesn't read.
       They need opposite responses — one is the provider's limit, the other is
       our bug — and there is no console on a TV to tell them apart. So the reply
       describes itself, in place, on the GREEN overlay.

       Reports the shape rather than the contents: enough to recognise a missed
       format, without putting a wall of provider JSON on screen. */
    function describePayload(data) {
        if (data === null || data === undefined) return 'reply empty';
        if (typeof data !== 'object') return 'reply was ' + (typeof data);

        var parts = [];
        var names = ['info', 'movie_data'];
        for (var i = 0; i < names.length; i++) {
            var o = data[names[i]];
            if (o === null || o === undefined) continue;
            if (typeof o !== 'object') { parts.push(names[i] + '=' + (typeof o)); continue; }
            parts.push(names[i] + '{' + subKeyReport(o) + '}');
        }
        var top = subKeyReport(data);
        if (top) parts.push('top{' + top + '}');
        return parts.length ? parts.join(' ') : 'no subtitle-ish keys anywhere';
    }

    /* Which of the keys we look at exist on this object, and what's in them. */
    function subKeyReport(o) {
        var keys = ['subtitles', 'subtitle', 'subs', 'sub',
                    'subtitle_tracks', 'text_tracks', 'streams'];
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            if (!(keys[i] in o)) continue;
            out.push(keys[i] + ':' + shapeOf(o[keys[i]], keys[i] === 'streams'));
        }
        if (out.length) return out.join(' ');

        /* No subtitle key is the end of the road for this title — but WHICH
           keys are present says whether it's the end of the road for the whole
           provider. A panel returning only catalogue fields (plot, cast, genre)
           never probes its files, so it will never report subtitles for
           anything; one returning bitrate/duration/video/audio does probe and is
           merely dropping the subtitle streams. Same empty result, different
           causes, and nothing else on screen distinguishes them. */
        var present = ownKeys(o);
        if (!present.length) return 'empty object';
        /* Every key, uncapped. A truncated list is worse than useless here: the
           whole point is to spot a subtitle field under a name this code doesn't
           know, and a cap hides exactly the unfamiliar names it exists to find.
           Joined with a SPACE after each comma — an unbroken comma-run has no
           break opportunity, so it ran off the right edge of the TV instead of
           wrapping, taking the last keys with it. */
        return 'none; has ' + present.join(', ');
    }

    function shapeOf(v, isStreams) {
        if (v === null || v === undefined) return 'null';
        if (isArray(v)) {
            if (isStreams) {
                var subs = subtitleStreams(v);
                return 'array(' + v.length + ', ' + (subs ? subs.length : 0) + ' subtitle)';
            }
            if (!v.length) return 'empty array';
            var first = v[0];
            if (typeof first === 'string') return 'array(' + v.length + ') of strings';
            if (first && typeof first === 'object') {
                return 'array(' + v.length + ') of {' + ownKeys(first).slice(0, 6).join(',') + '}';
            }
            return 'array(' + v.length + ')';
        }
        if (typeof v === 'string') return v ? 'string(' + v.length + ' chars)' : 'empty string';
        if (typeof v === 'object') return 'object{' + ownKeys(v).slice(0, 6).join(',') + '}';
        return String(typeof v);
    }

    function ownKeys(o) {
        var out = [];
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out.push(k);
        return out;
    }

    /* The panel's reply itself, shrunk enough to store and read on a TV. Long
       text (plot, cast, base64 artwork) is elided by length because it is never
       the answer, but every KEY and every short value survives — when the
       question is "where does this provider hide its subtitles", the answer is
       a key name, and no summary can anticipate which one. */
    function rawSample(data, max) {
        max = max || 1800;
        if (data === null || data === undefined) return 'reply was empty';
        var seen = [];
        var json;
        try {
            json = JSON.stringify(data, function (k, v) {
                if (typeof v === 'string') {
                    return v.length > 60 ? '…(' + v.length + ' chars)' : v;
                }
                if (v && typeof v === 'object') {
                    if (seen.indexOf(v) !== -1) return '…(circular)';
                    seen.push(v);
                }
                return v;
            });
        } catch (e) { return 'reply could not be read'; }
        if (!json) return 'reply was empty';
        return json.length > max
            ? json.slice(0, max) + '…(+' + (json.length - max) + ' more)'
            : json;
    }

    /* Key aliases seen across panels, then a last look at ffprobe output.
       Several panels never populate a `subtitles` key at all but do return the
       raw ffprobe stream list, where subtitle tracks sit alongside the video and
       audio ones — findable, but only if you filter by codec_type rather than
       expecting a dedicated key. */
    var PICK_KEYS = ['subtitles', 'subtitle', 'subs', 'sub',
                     'subtitle_tracks', 'text_tracks'];

    function pick(o) {
        if (!o) return null;
        /* Each candidate key must be tested for CONTENT, not truthiness. An
           empty array is truthy in JavaScript, so the old `o.subtitles || …`
           chain stopped dead on `"subtitles": []` — which is exactly what a
           panel sends when it has no sidecar files but does ship the ffprobe
           stream list. The empty array won the chain, was returned as the
           answer, and the `streams` fallback below — the one place the muxed
           subtitle tracks were actually described — was never reached. The
           result was "this title has no subtitles" for a file the same reply
           described two of. Same reasoning for an empty object or a blank
           string, both of which panels also send. */
        for (var i = 0; i < PICK_KEYS.length; i++) {
            var v = o[PICK_KEYS[i]];
            if (hasContent(v)) return v;
        }
        return subtitleStreams(o.streams) || subtitleStreams(o.ffprobe) || null;
    }

    function hasContent(v) {
        if (v === null || v === undefined || v === false) return false;
        if (isArray(v)) return v.length > 0;
        if (typeof v === 'object') {
            for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) return true;
            return false;
        }
        return String(v).replace(/^\s+|\s+$/g, '') !== '';
    }

    /* The subtitle entries out of a mixed ffprobe stream list, or null if there
       is no such list to read. Null rather than [] so callers can tell "no
       stream list" from "a stream list with no subtitles in it". */
    function subtitleStreams(streams) {
        if (!isArray(streams)) return null;
        var out = [];
        for (var i = 0; i < streams.length; i++) {
            var s = streams[i];
            if (s && s.codec_type === 'subtitle') out.push(s);
        }
        return out.length ? out : null;
    }

    function merge(results) {
        var out = { files: [], embedded: [], unknown: 0 };
        var seenUrl = {}, seenEmbedded = {};
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            for (var f = 0; f < r.files.length; f++) {
                var u = r.files[f].url;
                if (!u || seenUrl[u]) continue;
                seenUrl[u] = 1;
                out.files.push(r.files[f]);
            }
            for (var e = 0; e < r.embedded.length; e++) {
                var key = String(r.embedded[e].index) + '|' + r.embedded[e].lang;
                if (seenEmbedded[key]) continue;
                seenEmbedded[key] = 1;
                out.embedded.push(r.embedded[e]);
            }
            out.unknown += r.unknown;
        }
        return out;
    }

    /* ── Sidecar probe ────────────────────────────────────────────────────────
       Several panels serve a subtitle file next to the stream at the same path
       with the extension swapped, without ever mentioning it in the API. It is
       the only remaining place a real file can come from, so it is worth one
       speculative request — but only when the API gave us no files, and only
       with two guards, because the same URL on a panel that ignores extensions
       returns the MOVIE:

         • a Range header caps what we ask for at 128 KB
         • the response is rejected before its body is read unless the
           content-type looks textual and the length is subtitle-sized

       Then the body itself must actually look like SRT or WebVTT. A panel's
       404 page is text/html of a plausible size and would otherwise sail
       through as a "subtitle" that renders as markup over the video. */
    /* SRT and VTT go to a <track> after conversion; ASS/SSA are drawn by
       player/ass.js. `.sub` stays on the list without a renderer behind it
       because finding one is still worth reporting — "the file is there but in
       a format this app can't render" is a different answer from "there is no
       file", and only one of them is worth acting on. */
    var PROBE_EXTS   = ['srt', 'vtt', 'ass', 'ssa', 'sub'];
    var PROBE_LANGS  = ['en', 'eng'];
    var PROBE_MAX    = 512 * 1024;
    var PROBE_TIMEOUT = 3500;

    function looksLikeSubtitle(text) {
        if (!text) return false;
        var head = String(text).slice(0, 4096);
        if (/^﻿?\s*WEBVTT/.test(head)) return true;
        /* ASS/SSA. This test used to be SRT/VTT only, which meant the probe
           fetched a perfectly good `.ass` sitting next to the stream, failed to
           recognise it, and logged "not subtitle text" — the file was on the
           list of extensions to look for but could never pass the check that
           decides whether to keep it. Matched on the section headers rather than
           a timestamp because ASS timecodes ("0:00:12.30") are far too loose a
           pattern to identify a file by on their own. */
        if (/\[Script Info\]/i.test(head) ||
            (/\[(?:V4\+?|V4\+\+) Styles\]/i.test(head) && /\[Events\]/i.test(head))) return true;
        return /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(head);
    }

    /* What every candidate returned. A probe that can only say "found nothing"
       cannot distinguish a provider with no sidecar files from a fault in the
       probe itself — which is precisely how the octet-stream rule below hid
       real subtitles for months. There is no console on a TV, so the probe
       keeps its own record. */
    var _probeLog = [];
    function probeLog() { return _probeLog.slice(); }

    function probeOne(url) {
        var name = String(url).replace(/^.*\//, '').replace(/\?.*$/, '');
        return Net.request(url, {
            timeout: PROBE_TIMEOUT,
            headers: { 'Range': 'bytes=0-131071' }
        }).then(function (res) {
            var type = '', len = 0, partial = false;
            try {
                type = (res.headers && res.headers.get('content-type')) || '';
                len  = parseInt((res.headers && res.headers.get('content-length')) || '0', 10) || 0;
                partial = (res.status === 206);
            } catch (e) {}

            /* Only unambiguous media is refused outright. `octet-stream` is NOT
               unambiguous — it is what most servers label a .srt with, since SRT
               has no registered MIME type — so refusing it here threw away real
               subtitle files before looksLikeSubtitle() could identify them, and
               reported "none next to the stream" for providers that had them.
               Size, below, is what actually stops a movie being downloaded. */
            if (/video|audio|image/i.test(type)) {
                _probeLog.push(name + ': is ' + type);
                return null;
            }

            /* A 206 means the Range was honoured, so at most 128KB is arriving
               regardless of how large the file is. Without one, insist on a
               declared length that is small enough to be a subtitle. */
            if (!partial && (len === 0 || len > PROBE_MAX)) {
                _probeLog.push(name + ': ' + (len
                    ? 'too big (' + Math.round(len / 1024) + 'KB)'
                    : 'no size given and range ignored'));
                return null;
            }
            return res.text();
        }).then(function (text) {
            if (text === null || text === undefined) return null;
            if (looksLikeSubtitle(text)) { _probeLog.push(name + ': subtitle found'); return url; }
            _probeLog.push(name + ': not subtitle text');
            return null;
        })['catch'](function (err) {
            _probeLog.push(name + ': ' + ((err && err.message) || 'request failed'));
            return null;
        });
    }

    function probeAll(urls) {
        var pending = [];
        for (var i = 0; i < urls.length; i++) pending.push(probeOne(urls[i]));
        return Promise.all(pending).then(function (res) {
            var out = [];
            for (var j = 0; j < res.length; j++) if (res[j]) out.push(res[j]);
            return out;
        });
    }

    /* `streamUrl` is the playback URL — the extension is swapped on a copy.

       Done in two stages so the common case stays cheap. Stage one is the plain
       name the video has; only if that finds nothing does stage two try the
       language-tagged names ("movie.en.srt" beside "movie.mkv"), which is how a
       lot of providers label them and which the old single-stage probe never
       looked for at all. */
    function probeSidecars(streamUrl) {
        var stem = String(streamUrl || '').replace(/\.[a-z0-9]{2,4}(\?[^#]*)?$/i, '');
        if (!stem || stem === streamUrl) return Promise.resolve([]);
        _probeLog = [];

        var plain = [];
        for (var i = 0; i < PROBE_EXTS.length; i++) plain.push(stem + '.' + PROBE_EXTS[i]);

        return probeAll(plain).then(function (found) {
            if (found.length) return found;
            var tagged = [];
            for (var l = 0; l < PROBE_LANGS.length; l++) {
                /* Only the two text formats worth a second round of requests. */
                tagged.push(stem + '.' + PROBE_LANGS[l] + '.srt');
                tagged.push(stem + '.' + PROBE_LANGS[l] + '.vtt');
            }
            return probeAll(tagged);
        }).then(function (found) {
            var out = [];
            for (var j = 0; j < found.length; j++) {
                out.push({ url: found[j], lang: guessLangFromUrl(found[j]), label: 'Subtitles (file)' });
            }
            return out;
        });
    }

    /* ── Reporting ────────────────────────────────────────────────────────────
       What the player shows instead of a bare "no subtitles". Every branch here
       names something the user can actually do next; a message that only states
       a limitation is not worth showing. */
    function describe(result, opts) {
        opts = opts || {};
        var r = result || { files: [], embedded: [], unknown: 0 };

        /* The suggestion has to match what the menu actually offers. Telling
           someone to "search below" when there is no such row is the same dead
           end this message exists to remove — and the row's availability
           changed: one provider now needs no key, so search is offered on every
           title and this text can finally point at something that is always
           there. */
        var fallback = opts.hasOpenSubtitles
            ? 'use “Search online…” below'
            : 'use “Search online…” below (and add a free OpenSubtitles API key in ' +
              'Settings → Subtitles for better English results)';

        if (r.embedded.length) {
            var names = [];
            for (var i = 0; i < r.embedded.length && i < 4; i++) {
                names.push(r.embedded[i].label || langName(r.embedded[i].lang) || 'Unknown');
            }
            var list = names.join(', ') + (r.embedded.length > 4 ? ', …' : '');
            var msg = 'Your provider lists ' + r.embedded.length + ' subtitle track' +
                      (r.embedded.length === 1 ? '' : 's') + ' (' + list + ') built into this video, ' +
                      'not as separate files.';
            if (opts.hasHlsTier) {
                msg += ' Press RED to try the HLS player, which reads tracks in software — ' +
                       'otherwise ' + fallback + '.';
            } else {
                msg += " This TV's decoder keeps those to itself, so " + fallback + '.';
            }
            return msg;
        }

        if (r.failed && r.requested > 0 && r.failed >= r.requested) {
            return 'Your provider listed ' + r.requested + ' subtitle file' +
                   (r.requested === 1 ? '' : 's') + ' for this title, but ' +
                   (r.requested === 1 ? 'it' : 'they') + " couldn't be downloaded — " + fallback + '.';
        }

        if (r.unknown) {
            return 'Your provider returned ' + r.unknown + ' subtitle entr' +
                   (r.unknown === 1 ? 'y' : 'ies') + ' this app could not read — ' + fallback + '.';
        }

        return 'Your provider supplies no subtitles for this title. ' +
               'Most embed them in the video instead — ' + fallback + '.';
    }

    /* ── Diagnostics ──────────────────────────────────────────────────────────
       A retail TV has no console, so the only way to answer "why are there no
       subtitles" is to write down what happened and show it in Settings →
       Diagnostics. One record, overwritten each time — this is a debugging aid,
       not a history. */
    function recordDiag(title, result, extra) {
        var r = result || { files: [], embedded: [], unknown: 0 };
        var langs = [];
        for (var i = 0; i < r.embedded.length; i++) {
            var n = langName(r.embedded[i].lang) || r.embedded[i].label;
            if (n && langs.indexOf(n) === -1) langs.push(n);
        }
        for (var f = 0; f < r.files.length; f++) {
            var fn = langName(r.files[f].lang) || r.files[f].label;
            if (fn && langs.indexOf(fn) === -1) langs.push(fn);
        }
        var rec = {
            ts:        Date.now(),
            title:     title || '',
            reported:  r.files.length + r.embedded.length + r.unknown,
            files:     r.files.length,
            embedded:  r.embedded.length,
            unknown:   r.unknown,
            languages: langs.join(', ')
        };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) rec[k] = extra[k];

        /* Four different places look subtitles up for one title — the detail
           view, the episode list, the play handover and the player's own
           retry — and only some of them have the panel's reply in hand. They
           all write here, so a later caller without the reply used to erase the
           record left by the one that had it, and Diagnostics showed counts
           with no way to see what the panel actually sent. Carry the reply
           forward while the record is still about the SAME title; a different
           title is genuinely a fresh record and must not inherit the old one's
           payload. */
        var prev = Store.get(DIAG_KEY, null);
        if (prev && prev.title === rec.title) {
            if (!rec.panelShape && prev.panelShape) rec.panelShape = prev.panelShape;
            if (!rec.panelRaw   && prev.panelRaw)   rec.panelRaw   = prev.panelRaw;
        }
        Store.set(DIAG_KEY, rec);
        return rec;
    }

    function updateDiag(patch) {
        var rec = Store.get(DIAG_KEY, null);
        if (!rec) return;
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = patch[k];
        Store.set(DIAG_KEY, rec);
    }

    /* ── Format conversion ────────────────────────────────────────────────────
       <track> only accepts WebVTT, and providers overwhelmingly ship SRT. The
       conversion is deliberately conservative: the cue index lines go, the
       comma decimal separator becomes a dot, and nothing else is touched.
       Timestamps missing an hours field ("00:12,500") are a real thing in
       hand-made SRT files and are normalised, because WebVTT rejects them
       outright and the whole track would silently show nothing. */
    function toVtt(text) {
        var s = String(text || '').replace(/^﻿/, '').replace(/\r+/g, '').trim();
        if (/^WEBVTT/.test(s)) return s;

        s = s
            /* Drop the numeric cue index on its own line. */
            .replace(/^\d+\s*$/gm, '')
            /* MM:SS,mmm → 00:MM:SS.mmm  (both ends of the arrow, hence twice). */
            .replace(/(^|\s)(\d{1,2}:\d{2}[,.]\d{1,3})(\s*-->)/g, function (_, pre, t, post) {
                return pre + '00:' + t.replace(',', '.') + post;
            })
            .replace(/(-->\s*)(\d{1,2}:\d{2}[,.]\d{1,3})(\s|$)/g, function (_, pre, t, post) {
                return pre + '00:' + t.replace(',', '.') + post;
            })
            /* HH:MM:SS,mmm → HH:MM:SS.mmm */
            .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return 'WEBVTT\n\n' + s;
    }

    return {
        DIAG_KEY: DIAG_KEY,
        LANG_NAMES: LANG_NAMES, langName: langName,
        parse: parse, fromVodInfo: fromVodInfo, fromEpisode: fromEpisode,
        describePayload: describePayload, rawSample: rawSample,
        probeSidecars: probeSidecars, probeLog: probeLog,
        looksLikeSubtitle: looksLikeSubtitle,
        describe: describe, recordDiag: recordDiag, updateDiag: updateDiag,
        toVtt: toVtt
    };
}());
