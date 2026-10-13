// ==UserScript==
// @name         YouTube Shorts j/k navigation
// @namespace    local.youtube-shorts-jk
// @description  On YouTube Shorts: j = next video, k = previous video, ; = like, h = play/pause.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  // Guard against being injected twice.
  if (window.__ytShortsJK) return;
  window.__ytShortsJK = true;

  const NEXT_LABEL = /\bnext\b/i;
  const PREV_LABEL = /\bprevious\b|\bprev\b/i;

  const onShorts = () => location.pathname.startsWith("/shorts");

  function isTyping(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    return path.some(
      (el) =>
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable),
    );
  }

  // The Shorts player's own up/down arrow buttons.
  function findNavButton(isNext) {
    const host = document.querySelector(
      isNext ? "#navigation-button-down" : "#navigation-button-up",
    );
    if (host) return host.querySelector("button") || host;

    // Fallback: match by accessible label.
    const label = isNext ? NEXT_LABEL : PREV_LABEL;
    for (const b of document.querySelectorAll("button[aria-label]")) {
      if (label.test(b.getAttribute("aria-label"))) return b;
    }
    return null;
  }

  // Last resort: hand YouTube the arrow key it already uses in Shorts.
  function sendArrow(isNext) {
    const key = isNext ? "ArrowDown" : "ArrowUp";
    const init = {
      key,
      code: key,
      keyCode: isNext ? 40 : 38,
      which: isNext ? 40 : 38,
      bubbles: true,
      composed: true,
      cancelable: true,
    };
    (document.activeElement || document.body).dispatchEvent(
      new KeyboardEvent("keydown", init),
    );
  }

  // The Short currently on screen. YouTube keeps neighbouring Shorts in the
  // page too, so everything below is scoped to this one.
  function activeReel() {
    const marked = document.querySelector("ytd-reel-video-renderer[is-active]");
    if (marked) return marked;
    const mid = window.innerHeight / 2;
    for (const r of document.querySelectorAll("ytd-reel-video-renderer")) {
      const b = r.getBoundingClientRect();
      if (b.top <= mid && b.bottom >= mid && b.height > 0) return r;
    }
    return null;
  }

  function findLikeButton(scope) {
    // [id=...] rather than #id: YouTube repeats this id once per Short.
    const direct = scope.querySelector(
      '[id="like-button"] button, like-button-view-model button, ytd-like-button-renderer button',
    );
    if (direct) return direct;
    // Fallback by label. "like" also matches "unlike"; skip "dislike".
    for (const b of scope.querySelectorAll("button[aria-label]")) {
      const label = b.getAttribute("aria-label");
      if (/like/i.test(label) && !/dislike/i.test(label)) return b;
    }
    return null;
  }

  function findVideo(scope) {
    const videos = [...scope.querySelectorAll("video")];
    return (
      videos.find((v) => !v.paused) ||
      videos.find((v) => v.readyState > 0) ||
      videos[0] ||
      null
    );
  }

  const ACTIONS = {
    // j / k: next / previous Short
    next: () => {
      const btn = findNavButton(true);
      if (btn) btn.click();
      else sendArrow(true);
    },
    prev: () => {
      const btn = findNavButton(false);
      if (btn) btn.click();
      else sendArrow(false);
    },
    // ; -> like (a second press un-likes, same as the heart button)
    like: () => {
      const btn = findLikeButton(activeReel() || document);
      if (btn) btn.click();
    },
    // h -> play / pause
    playPause: () => {
      const video = findVideo(activeReel() || document);
      if (!video) return;
      if (video.paused) video.play()?.catch?.(() => {});
      else video.pause();
    },
  };

  const KEYMAP = { j: "next", k: "prev", ";": "like", h: "playPause" };

  function handleKey(e) {
    if (!e.key) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = KEYMAP[key];
    if (!action) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!onShorts()) return; // leave normal videos alone
    if (isTyping(e)) return;

    // Stop YouTube's own handling of the key (j/k rewind and pause).
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // one action per press, even if the key is held

    ACTIONS[action]();
  }

  window.addEventListener("keydown", handleKey, true);
  console.log(
    "[youtube-shorts-jk] loaded (j = next, k = previous, ; = like, h = play/pause)",
  );
})();