// Comfyrizz example gallery.
// Fetches gallery.json (the manifest produced by scripts/gallery-manifest.mjs,
// see docs/specs/SUBMISSION.md S09/S10) and renders one card per example.
// Static and dependency-free: no external CDNs, no build step.
//
// All manifest text is escaped before it is inserted into the DOM. Videos
// autoplay only when the visitor has not asked for reduced motion.

(function () {
  'use strict';

  var GALLERY = document.getElementById('gallery');
  var MANIFEST_URL = 'gallery.json';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  // ------------------------------------------------------- path resolution

  // Manifest paths are repository-relative (for example
  // "examples/launch-demo/out/launch-demo.mp4"); this page lives in
  // "docs/gallery/". Resolve repo-relative paths against the repository root
  // so the page works on GitHub Pages (with or without a project subpath)
  // and under any local HTTP server. Falls back to "../../" when the page
  // directory does not end in "docs/gallery/".
  var repoRootUrl = (function () {
    var pageUrl = new URL('.', window.location.href);
    var suffix = 'docs/gallery/';
    var pathname = pageUrl.pathname;
    if (pathname.endsWith('/' + suffix)) {
      return new URL(pathname.slice(0, pathname.length - suffix.length), pageUrl);
    }
    return new URL('../../', pageUrl);
  })();

  function resolveRepoPath(repoRelative) {
    if (!isNonEmptyString(repoRelative)) return null;
    try {
      return new URL(repoRelative, repoRootUrl).href;
    } catch (error) {
      return null;
    }
  }

  // ------------------------------------------------------------ card layout

  function formatDuration(durationSec) {
    if (durationSec === null || durationSec === undefined || durationSec === '') return null;
    var duration = Number(durationSec);
    if (!Number.isFinite(duration) || duration < 0) return null;
    return Math.round(duration) + ' s';
  }

  // Render command shown on cards whose video is not committed. Documented,
  // CPU-rendered command for the bundled example (docs/RELEASE_CHECK.md); for
  // the rest, mark the guessed script name as unverified and point at the
  // example README for the real command.
  function renderCommand(manifestEntry) {
    if (manifestEntry && manifestEntry.id === 'launch-demo') {
      return 'pnpm --filter @comfyrizz/renderer render:example';
    }
    var id = manifestEntry && isNonEmptyString(manifestEntry.id)
      ? manifestEntry.id
      : '<example-id>';
    return '[unverified] pnpm render:' + id;
  }

  function videoHtml(manifestEntry, resolvedVideo, resolvedPoster) {
    return (
      '<video controls preload="metadata" width="640" height="360"' +
      (resolvedPoster ? ' poster="' + escapeHtml(resolvedPoster) + '"' : '') +
      ' src="' + escapeHtml(resolvedVideo) + '"' +
      ' aria-label="' + escapeHtml(manifestEntry.title + ' render') + '"' +
      ' playsinline muted loop></video>'
    );
  }

  function posterHtml(manifestEntry, resolvedVideo, resolvedPoster) {
    var alt = resolvedVideo
      ? manifestEntry.title + ' poster; the video renders locally, see the card footer'
      : manifestEntry.title + ' example poster';
    if (isNonEmptyString(manifestEntry.poster)) {
      return (
        '<img class="card-media card-media-img" src="' + escapeHtml(resolvedPoster) +
        '" alt="' + escapeHtml(alt) + '" width="640" height="360" loading="lazy">'
      );
    }
    return (
      '<div class="card-media card-media-empty" role="img" aria-label="' +
      escapeHtml(alt) + '">' +
      '<p class="card-media-text">No poster or video committed for this example.</p>' +
      '<p class="card-media-text">Render locally: <code>' +
      escapeHtml(renderCommand(manifestEntry)) + '</code></p>' +
      '</div>'
    );
  }

  function cardHtml(manifestEntry) {
    if (!manifestEntry || typeof manifestEntry !== 'object') return null;

    var title = isNonEmptyString(manifestEntry.title)
      ? manifestEntry.title
      : (isNonEmptyString(manifestEntry.id) ? manifestEntry.id : 'Untitled example');
    var description = manifestEntry.description;
    var duration = formatDuration(manifestEntry.durationSec);
    var durationText = duration === null
      ? 'Duration: not in the manifest'
      : 'Duration: ' + escapeHtml(duration);
    var resolvedVideo = resolveRepoPath(manifestEntry.video);
    var resolvedPoster = resolveRepoPath(manifestEntry.poster);
    var media = resolvedVideo
      ? videoHtml(manifestEntry, resolvedVideo, resolvedPoster)
      : posterHtml(manifestEntry, resolvedVideo, resolvedPoster);

    var readmeLink = resolveRepoPath(manifestEntry.readme);
    var footer = readmeLink
      ? '<a class="card-readme" href="' + escapeHtml(readmeLink) + '">Read the README for ' +
        escapeHtml(title) + '</a>'
      : '<span class="card-readme card-readme-plain">No README path in the manifest; see the example directory</span>';

    var tags = Array.isArray(manifestEntry.tags) ? manifestEntry.tags : [];

    return (
      '<li class="card">' +
      '<h2 class="card-title">' + escapeHtml(title) + '</h2>' +
      (isNonEmptyString(manifestEntry.id)
        ? '<p class="card-id">id: <code>' + escapeHtml(manifestEntry.id) + '</code></p>'
        : '') +
      '<div class="card-media-wrap">' + media + '</div>' +
      '<p class="card-duration">' + durationText + '</p>' +
      (isNonEmptyString(description)
        ? '<p class="card-description">' + escapeHtml(description) + '</p>'
        : '') +
      (tags.length > 0
        ? '<p class="card-tags">' + tags.map(function (tag) {
            return '<span class="card-tag">' + escapeHtml(tag) + '</span>';
          }).join('') + '</p>'
        : '') +
      footer +
      '</li>'
    );
  }

  function renderManifest(manifest) {
    if (!Array.isArray(manifest)) {
      setStatus('gallery.json did not contain a JSON array, so it is not a manifest this page can render.');
      return;
    }
    var rendered = 0;
    var html = '<ul class="gallery-list">';
    for (var i = 0; i < manifest.length; i++) {
      var card = cardHtml(manifest[i]);
      if (card !== null) {
        html += card;
        rendered++;
      }
    }
    html += '</ul>';
    if (rendered === 0) {
      html += '<p class="status status-info">The manifest loaded but rendered no cards.</p>';
    }
    GALLERY.innerHTML = html;
    GALLERY.setAttribute('aria-busy', 'false');
    applyReducedMotion();
  }

  function setStatus(message) {
    GALLERY.innerHTML =
      '<p class="status status-error">' + escapeHtml(message) + '</p>';
    GALLERY.setAttribute('aria-busy', 'false');
  }

  // ------------------------------------------------------ reduced motion

  // Reduced-motion visitors: make sure nothing plays without an explicit
  // action. The <video> elements above only carry muted/loop autoplay hints
  // through the browser's own autoplay policy, so this stops them and also
  // prevents any later autoplay attempt.
  var REDUCED_MOTION_STYLE = document.createElement('style');
  REDUCED_MOTION_STYLE.textContent =
    '@media (prefers-reduced-motion: reduce) { .gallery-list video { display: none; } }';

  function applyReducedMotion() {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.head.appendChild(REDUCED_MOTION_STYLE);
    var videos = GALLERY.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      try {
        videos[i].removeAttribute('autoplay');
        videos[i].pause();
      } catch (error) {
        // pause() can reject; leaving the video paused-on-load fallback is safe.
      }
    }
  }

  // --------------------------------------------------------------- bootstrap

  function fileProtocolMessage() {
    return (
      'This page was opened from file://, and browsers block fetch() for local ' +
      'files, so gallery.json could not be loaded and the cards cannot render. ' +
      'Serve this directory over HTTP instead — from the repository root run, ' +
      "for example, 'npx serve docs/gallery' (any static file server works) — " +
      'then open the page again, or view it on GitHub Pages where gallery.json ' +
      'is served next to this page.'
    );
  }

  function main() {
    GALLERY.setAttribute('aria-busy', 'true');
    fetch(MANIFEST_URL, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('gallery.json returned HTTP ' + response.status);
        }
        return response.json();
      })
      .then(renderManifest)
      .catch(function (error) {
        if (window.location.protocol === 'file:') {
          setStatus(fileProtocolMessage());
          return;
        }
        var detail = error instanceof Error ? error.message : String(error);
        setStatus('Could not load the gallery: ' + detail +
          '. gallery.json should sit next to this page; check it and reload.');
      });
  }

  main();
})();
