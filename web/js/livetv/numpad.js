/* livetv/numpad.js — type a channel number and go there. Exposes
 * window.ChannelNumbers.
 *
 * The number is the row's POSITION in whatever list is on screen, so
 * Favourites is 1..N and every category is its own 1..N. That is deliberate:
 * a provider's own channel numbers are frequently absent, frequently duplicated
 * across categories, and frequently disagree with the order the channels are
 * actually listed in — so a number you can see next to a row and count down to
 * is more useful than one that claims authority it doesn't have.
 *
 * Entry behaves like a television, because that is the thing everyone already
 * knows how to use:
 *   • digits accumulate — "1" then "2" means 12, not 1 then 2
 *   • it commits on a short pause, so single-digit channels need no OK
 *   • OK commits immediately, for when you don't want to wait
 *   • BACK cancels without changing channel
 *
 * The caller supplies the target, because the same keystrokes mean different
 * things on different screens: on Live TV they select a channel, in Multiview
 * they retune the focused tile.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.ChannelNumbers = (function () {
    'use strict';

    /* Long enough to reach for a second digit, short enough that a single-digit
       channel doesn't feel like it hung. Real TVs sit around 2s. */
    var COMMIT_MS = 2000;
    var ERROR_MS  = 1800;
    var MAX_DIGITS = 4;      // 9999 channels is past any real playlist

    var _buf    = '';
    var _timer  = null;
    var _el     = null;
    var _target = null;

    function isDigitKey(kc) {
        return (kc >= 48 && kc <= 57) ||        // top row
               (kc >= 96 && kc <= 105);         // numpad, for desktop testing
    }
    function digitOf(kc) { return kc >= 96 ? kc - 96 : kc - 48; }

    function active() { return _buf !== ''; }

    /* ── Overlay ──────────────────────────────────────────────────────────────
       Created on first use and left in the DOM afterwards — it is one small
       element, and building it per keystroke would be the one bit of work
       happening while the user is mid-input. */
    function el() {
        if (_el && _el.parentNode) return _el;
        _el = Dom.el('div', { id: 'chnum' }, [
            Dom.el('span', { id: 'chnum-digits' }),
            Dom.el('span', { id: 'chnum-name' })
        ]);
        document.body.appendChild(_el);
        return _el;
    }

    /* Digits are passed in rather than read from `_buf`, because the moment
       that matters most is the successful commit — where the buffer has
       already been cleared but the number the user typed still needs to stay
       on screen while the channel changes under it. */
    function paint(digits, name, isError) {
        var box = el();
        box.className = 'chnum-visible' + (isError ? ' chnum-error' : '');
        Dom.byId('chnum-digits').textContent = digits || '';
        Dom.byId('chnum-name').textContent = name || '';
    }

    function hide() {
        if (!_el) return;
        _el.className = '';
        /* Clear the text too, so a half-typed number can't reappear for a frame
           the next time the box is shown. */
        Dom.byId('chnum-digits').textContent = '';
        Dom.byId('chnum-name').textContent = '';
    }

    function reset() {
        clearTimeout(_timer);
        _timer = null;
        _buf = '';
    }

    function cancel() {
        reset();
        hide();
    }

    /* What the number currently points at, so the overlay can show the channel
       name as you type rather than making you commit blind. */
    function previewName() {
        if (!_target || !_buf) return '';
        var n = parseInt(_buf, 10);
        if (!(n >= 1) || n > _target.total()) return '';
        return (_target.nameAt ? _target.nameAt(n - 1) : '') || '';
    }

    function push(digit) {
        if (_buf.length >= MAX_DIGITS) return;
        /* Leading zeros would let "007" mean 7 while displaying nonsense; drop
           them rather than silently reinterpreting what was typed. */
        if (_buf === '' && digit === 0) return;
        _buf += String(digit);

        paint(_buf, previewName(), false);

        clearTimeout(_timer);
        _timer = setTimeout(commit, COMMIT_MS);
    }

    function commit() {
        clearTimeout(_timer);
        _timer = null;
        if (!_buf || !_target) { cancel(); return; }

        var typed = _buf;
        var n     = parseInt(typed, 10);
        var total = _target.total();

        if (!(n >= 1) || n > total) {
            /* Say what went wrong instead of silently doing nothing — with a
               600-channel list it is genuinely unclear whether 700 was refused
               or simply missed. */
            reset();
            paint(typed, total ? 'No channel ' + n + ' — this list has ' + total
                               : 'Nothing to tune to', true);
            _timer = setTimeout(hide, ERROR_MS);
            return;
        }

        var index = n - 1;
        var name  = (_target.nameAt ? _target.nameAt(index) : '') || '';
        reset();
        /* Hold the number and the name up while the channel actually changes —
           the switch takes a moment, and a box that blanked the instant you
           committed would leave nothing confirming what you picked. */
        paint(typed, name, false);
        _timer = setTimeout(hide, 1200);
        _target.pick(index);
    }

    /* Returns true when the press was consumed, so the caller knows whether to
       preventDefault and stop looking for another meaning for it. */
    function handleKey(e, target) {
        var kc = Dom.keyCode(e);
        var K  = Dom.KEY;

        if (isDigitKey(kc)) {
            _target = target;
            push(digitOf(kc));
            return true;
        }
        if (!active()) return false;          // nothing in progress; not ours

        if (kc === K.ENTER) { commit(); return true; }
        if (kc === K.BACK || kc === K.ESC) { cancel(); return true; }

        /* Any other key means the user has moved on — drop the half-typed
           number rather than letting it commit under them a second later. */
        cancel();
        return false;
    }

    return {
        COMMIT_MS: COMMIT_MS,
        isDigitKey: isDigitKey,
        handleKey: handleKey, cancel: cancel, active: active
    };
}());
