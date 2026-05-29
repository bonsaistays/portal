(function () {
  var nav        = document.querySelector('.nav');
  var hamburger  = document.querySelector('.nav-hamburger');
  if (!nav || !hamburger) return;

  // Toggle menu open / closed
  hamburger.addEventListener('click', function () {
    var isOpen = nav.classList.toggle('nav-open');
    hamburger.classList.toggle('open', isOpen);
    hamburger.setAttribute('aria-expanded', isOpen);
  });

  // Close menu when any nav link is tapped
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('nav-open');
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    });
  });

  // Close menu when tapping outside the nav
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('nav-open') && !nav.contains(e.target)) {
      nav.classList.remove('nav-open');
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    }
  });
})();
