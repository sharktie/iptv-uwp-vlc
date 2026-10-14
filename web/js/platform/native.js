/* platform/native.js — the Xbox / Windows app this web app runs inside.
 *
 * Loaded on every page in <head>, straight after assets/boot.js and before
 * anything else, so its key listeners run first. In a plain browser there is
 * no window.chrome.webview: Native.available is false, nothing here does
 * anything, and the app behaves as it always has.
 *
 * Inside the app it:
 *   • talks to the native side (IPTV/Bridge/AppBridge.cs; messages are listed
 *     in docs/bridge.md),
 *   • turns controller buttons into the TV-remote key codes every page already
 *     handles, so no page needs to know about the controller,
 *   • opens the console keyboard for text boxes on Xbox,
 *   • hides the console's controller pointer and ignores its clicks.
 *
 * Controller → remote:
 *   D-pad / left stick  arrows          A   OK            B   BACK
 *   X   RED (retry with software decoding)               Y   YELLOW (lowest quality)
 *   View  GREEN (playback info)          Menu  play/pause
 *   LB / RB  previous / next channel     LT / RT  rewind / fast-forward          */
window.Native = (function () {
    'use strict';

    var webview = window.chrome && window.chrome.webview;
    var docEl = document.documentElement;
    var HELLO_KEY = 'native_hello';
    /* The console can deliver one press both through the app and as a key
       event in the page; the second copy within this window is dropped. */
    var DEDUPE_MS = 150;
    /* After OK lands on something that focuses a text box (Live TV search,
       the settings fields), the keyboard opens if the focus follows within this. */
    var SELECT_FOCUS_MS = 400;
    var TEXT_INPUT = /^(text|search|email|url|password|tel|number)$/i;

    var ACTIONS = {
        up:     { keyCode: 38,  key: 'ArrowUp' },
        down:   { keyCode: 40,  key: 'ArrowDown' },
        left:   { keyCode: 37,  key: 'ArrowLeft' },
        right:  { keyCode: 39,  key: 'ArrowRight' },
        select: { keyCode: 13,  key: 'Enter' },
        back:   { keyCode: 461, key: 'GoBack' },
        x:      { keyCode: 403, key: 'ColorF0Red' },
        y:      { keyCode: 405, key: 'ColorF2Yellow' },
        view:   { keyCode: 404, key: 'ColorF1Green' },
        menu:   { keyCode: 463, key: 'MediaPlayPause' },
        lb:     { keyCode: 427, key: 'ChannelUp' },
        rb:     { keyCode: 428, key: 'ChannelDown' },
        lt:     { keyCode: 412, key: 'MediaRewind' },
        rt:     { keyCode: 417, key: 'MediaFastForward' }
    };
    /* Real key events in the page that mean the same as a controller action,
       for the de-duplication above. */
    var KEY_ACTION = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        Enter: 'select', NumpadEnter: 'select', GoBack: 'back', BrowserBack: 'back', Escape: 'back'
    };

    var listeners = {};
    var pending = {};
    var nextRequestId = 1;
    var lastNative = {};
    var lastKey = {};
    var lastSelectAt = -1e9;
    var keyboardOpen = false;

    var info = { platform: webview ? 'desktop' : 'web', appVersion: null, vlcVersion: null };
    /* The app answers hello a moment after the page starts; the previous
       page's answer stands in until then, so things decided at startup (Xbox
       or not) are right from the first frame. */
    try {
        var saved = JSON.parse(sessionStorage.getItem(HELLO_KEY) || 'null');
        if (saved && webview) applyHello(saved);
    } catch (e) {}

    function applyHello(msg) {
        info.platform = msg.platform || 'desktop';
        info.appVersion = msg.appVersion || null;
        info.vlcVersion = msg.vlcVersion || null;
        docEl.classList.toggle('plat-xbox', info.platform === 'xbox');
        docEl.classList.toggle('no-pointer', info.platform === 'xbox');
        showVersion();
    }

    /* The pages print the webOS app's version; the app's own replaces it. */
    function showVersion() {
        if (!info.appVersion || !document.body) return;
        var els = document.querySelectorAll('[data-app-version]');
        for (var i = 0; i < els.length; i++) els[i].textContent = 'v' + info.appVersion;
    }
    if (webview) document.addEventListener('DOMContentLoaded', showVersion);

    function on(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
        return function () {
            var list = listeners[type] || [];
            var i = list.indexOf(fn);
            if (i !== -1) list.splice(i, 1);
        };
    }

    function emit(type, msg) {
        (listeners[type] || []).slice().forEach(function (fn) {
            try { fn(msg); } catch (e) { log('listener for ' + type + ' failed: ' + e); }
        });
    }

    function send(type, payload) {
        if (!webview) return;
        var msg = {};
        for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
        msg.type = type;
        try { webview.postMessage(msg); } catch (e) {}
    }

    /* A message the app answers with "response". */
    function request(type, payload, timeoutMs) {
        if (!webview) return Promise.reject(new Error('Not running in the app'));
        var requestId = String(nextRequestId++);
        return new Promise(function (resolve, reject) {
            var entry = { resolve: resolve, reject: reject, timer: 0 };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(function () {
                    delete pending[requestId];
                    reject(new Error('Timed out'));
                }, timeoutMs);
            }
            pending[requestId] = entry;
            var p = {};
            for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) p[k] = payload[k];
            p.requestId = requestId;
            send(type, p);
        });
    }

    function log(message) { send('app.log', { message: String(message) }); }

    function exit() { send('app.exit', {}); }

    // ── Controller → remote keys ──────────────────────────────────────────────

    function fireKey(action, target) {
        var def = ACTIONS[action];
        if (!def) return;
        target = target || document.activeElement || document.body;
        if (!target || target === document.documentElement) target = document.body;
        var ev;
        try {
            ev = new KeyboardEvent('keydown', {
                key: def.key, code: def.key, keyCode: def.keyCode, which: def.keyCode,
                bubbles: true, cancelable: true
            });
        } catch (e) { return; }
        /* Every page reads keyCode; make sure it is set whatever the engine
           does with the legacy init members. */
        if (ev.keyCode !== def.keyCode) {
            try {
                Object.defineProperty(ev, 'keyCode', { get: function () { return def.keyCode; } });
                Object.defineProperty(ev, 'which', { get: function () { return def.keyCode; } });
            } catch (e) {}
        }
        target.dispatchEvent(ev);
    }

    function isTextInput(el) {
        return !!el && ((el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text')) || el.tagName === 'TEXTAREA');
    }

    function onInput(msg) {
        var action = msg.action;
        if (!ACTIONS[action] || keyboardOpen) return;
        var now = performance.now();
        lastNative[action] = now;
        if (now - (lastKey[action] || -1e9) < DEDUPE_MS) return;
        if (action === 'select' && !msg.repeat) {
            var active = document.activeElement;
            if (info.platform === 'xbox' && isTextInput(active)) { openKeyboard(active); return; }
            lastSelectAt = now;
        }
        fireKey(action);
    }

    if (webview) {
        // Registered before any page script, so an echo never reaches the pages.
        window.addEventListener('keydown', function (e) {
            if (!e.isTrusted) return;
            var action = KEY_ACTION[e.key];
            if (!action) return;
            var now = performance.now();
            lastKey[action] = now;
            if (now - (lastNative[action] || -1e9) < DEDUPE_MS) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            /* A keyboard's Escape (or a mouse back button) on Windows means
               BACK, which the pages only know as the remote's code. */
            if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack') {
                e.preventDefault();
                e.stopImmediatePropagation();
                fireKey('back', e.target);
            }
        }, true);
    }

    // ── Text boxes: the console keyboard ──────────────────────────────────────

    function labelFor(el) {
        var text = el.getAttribute('aria-label') || '';
        if (!text && el.id) {
            var label = document.querySelector('label[for="' + el.id + '"]');
            if (label) text = label.textContent;
        }
        if (!text) {
            var wrap = el.closest && el.closest('label');
            if (wrap) text = wrap.textContent;
        }
        text = (text || el.placeholder || '').replace(/\s+/g, ' ').trim();
        return text || 'Enter text';
    }

    function kindFor(el) {
        var type = (el.type || 'text').toLowerCase();
        if (type === 'password' || type === 'email' || type === 'url' || type === 'search' || type === 'number') return type;
        if (/url|server|host|playlist|epg|m3u/i.test(el.id || '')) return 'url';
        return 'text';
    }

    function openKeyboard(el) {
        if (keyboardOpen) return;
        keyboardOpen = true;
        request('app.textInput', {
            label: labelFor(el),
            value: el.type === 'password' ? '' : (el.value || ''),
            kind: kindFor(el)
        }).then(function (result) {
            keyboardOpen = false;
            if (!result) return;
            el.value = result.text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (result.submitted) fireKey('select', el);
        }, function () {
            keyboardOpen = false;
        });
    }

    if (webview) {
        /* OK on a search row or a settings field focuses its text box (that is
           what opens the keyboard on a TV); follow it with the console's. */
        document.addEventListener('focusin', function (e) {
            if (info.platform !== 'xbox' || !isTextInput(e.target)) return;
            if (performance.now() - lastSelectAt < SELECT_FOCUS_MS) openKeyboard(e.target);
        }, true);

        /* The console turns the controller into a mouse pointer the page can't
           switch off. While it is unwanted (html.no-pointer, on Xbox) it is
           hidden by CSS and its input dropped here, so A doesn't also click
           whatever happens to be under it. Clicks made by code aren't trusted
           events, so the pages' own .click() calls still work. */
        ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove',
         'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'].forEach(function (type) {
            window.addEventListener(type, function (e) {
                if (!e.isTrusted || !docEl.classList.contains('no-pointer')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
            }, { capture: true, passive: false });
        });
    }

    // ── Messages from the app ─────────────────────────────────────────────────

    /* Also called directly by tools/dev-page.mjs, to act as the app. */
    function receive(msg) {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'response') {
            var entry = pending[msg.requestId];
            if (!entry) return;
            delete pending[msg.requestId];
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(msg.error));
            else entry.resolve(msg.result);
            return;
        }
        if (msg.type === 'app.hello') {
            applyHello(msg);
            try { sessionStorage.setItem(HELLO_KEY, JSON.stringify(msg)); } catch (e) {}
        }
        if (msg.type === 'input') onInput(msg);
        emit(msg.type, msg);
    }

    if (webview) {
        webview.addEventListener('message', function (event) { receive(event.data); });
        docEl.classList.add('plat-native');
        send('app.hello', {});
        window.addEventListener('error', function (e) {
            log('script error: ' + (e.message || e) + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
        });
    }

    return {
        available: !!webview,
        info: info,
        isXbox: function () { return info.platform === 'xbox'; },
        on: on,
        send: send,
        request: request,
        log: log,
        exit: exit,
        receive: receive,
        isTextInput: isTextInput
    };
}());
