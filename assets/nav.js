(function () {
  var nav       = document.querySelector('.nav');
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks  = document.querySelector('.nav-links');
  var navCta    = document.querySelector('.nav-cta');

  // ── Scroll effect ──────────────────────────────────────────────────────
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 40) { nav.classList.add('scrolled'); }
    else { nav.classList.remove('scrolled'); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (!nav || !hamburger) return;

  // ── Inject CTA buttons into dropdown (once, on first open) ───────────
  var ctaInjected = false;
  function injectMobileCTA() {
    if (ctaInjected || !navLinks || !navCta) return;
    ctaInjected = true;
    var li = document.createElement('li');
    li.className = 'nav-mobile-cta';
    li.style.listStyle = 'none';
    Array.from(navCta.children).forEach(function (child) {
      li.appendChild(child.cloneNode(true));
    });
    navLinks.appendChild(li);
  }

  // ── Open / close helpers ──────────────────────────────────────────────
  function openMenu() {
    injectMobileCTA();
    nav.classList.add('nav-open');
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeMenu() {
    nav.classList.remove('nav-open');
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  // ── Hamburger click ───────────────────────────────────────────────────
  hamburger.addEventListener('click', function (e) {
    e.stopPropagation();
    nav.classList.contains('nav-open') ? closeMenu() : openMenu();
  });

  // ── Close on link tap ─────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.nav-links a')) closeMenu();
  });

  // ── Close on outside tap ──────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('nav-open') && !nav.contains(e.target)) closeMenu();
  });

  // ── Close on Escape ───────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
})();
