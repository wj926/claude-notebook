// ========== KEYBOARD / VIEWPORT GUARD ==========
// Keeps the focused input visible when the mobile virtual keyboard opens,
// for both the file-browser (index.html) and the terminal page — the
// only assumption is that the root layout element has class "layout".
//
// Strategy: expose the live keyboard height as the CSS custom property
// `--kbd-h` on <html>, plus an `is-keyboard-open` class that CSS can
// hook for transitions. The layout's `padding-bottom` is the union
// (CSS `max()`) of `env(keyboard-inset-height)` (Chromium VirtualKeyboard
// API) and `var(--kbd-h)` (iOS Safari + every other browser via
// visualViewport).
//
// Why two sources?
//   - Chromium 94+ supports VirtualKeyboard API — we ask the keyboard to
//     overlay content and CSS env(keyboard-inset-height) reflects its
//     height. The browser updates this synchronously with no JS.
//   - iOS Safari does NOT support env(keyboard-inset-height); 100dvh
//     also does NOT shrink with the keyboard. The only reliable signal
//     is window.visualViewport, which we mirror into --kbd-h.
//
// History: an earlier version pinned window.scrollY to 0 on every
// scroll event. That fought the browser's native scroll-input-into-view
// and left inputs hidden behind the keyboard. The pin is gone — body
// is position:fixed so there's no window scroll to fight.
(function initKeyboardGuard() {
    const root = document.documentElement;

    // ---- VirtualKeyboard API (Chromium) ----
    if ('virtualKeyboard' in navigator) {
        try { navigator.virtualKeyboard.overlaysContent = true; } catch (_) {}
        // CSS env(keyboard-inset-height) on .layout handles spacing.
    }

    // ---- visualViewport → --kbd-h ----
    // Works on iOS Safari, Android Chrome (older), desktop browsers, etc.
    function updateKeyboardHeight() {
        const vv = window.visualViewport;
        if (!vv) return;
        // Keyboard height = invisible bottom strip of the layout viewport.
        // window.innerHeight is the layout viewport (fixed); vv.height +
        // vv.offsetTop is the visual viewport bottom edge. Their delta
        // is the chunk hidden by the keyboard.
        const kh = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        root.style.setProperty('--kbd-h', kh + 'px');
        root.classList.toggle('is-keyboard-open', kh > 0);
    }
    if (window.visualViewport) {
        updateKeyboardHeight();
        let rafId = null;
        const schedule = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                updateKeyboardHeight();
                // Re-nudge the focused element after layout settles so the
                // scroll-into-view below uses the post-keyboard geometry.
                const focused = document.activeElement;
                if (focused && focused !== document.body) scrollFocusIntoView(focused);
            });
        };
        window.visualViewport.addEventListener('resize', schedule);
        window.visualViewport.addEventListener('scroll', schedule);
    }

    // ---- Focus-into-view ----
    // When an input / textarea / contenteditable gets focus, scroll it
    // into the visible area of its nearest scrollable ancestor. block:
    // 'nearest' avoids yanking the viewport when the input is already
    // visible. Two-stage: once on the next frame for the immediate jump,
    // once after the keyboard animation settles (350 ms covers iOS).
    function scrollFocusIntoView(el) {
        if (!el || typeof el.scrollIntoView !== 'function') return;
        try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    }
    document.addEventListener('focusin', (e) => {
        const el = e.target;
        if (!el) return;
        requestAnimationFrame(() => scrollFocusIntoView(el));
        setTimeout(() => scrollFocusIntoView(el), 350);
    });
})();
