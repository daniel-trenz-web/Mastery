/* werkflow Website — Burger-Menü + sanftes Einblenden beim Scrollen */
(function () {
  'use strict';
  var b = document.querySelector('.burger');
  var m = document.querySelector('.mobile-menu');
  if (b && m) {
    b.addEventListener('click', function () {
      m.classList.toggle('open');
      b.setAttribute('aria-expanded', m.classList.contains('open') ? 'true' : 'false');
    });
  }

  // Reveal-on-Scroll: gängige Bausteine automatisch sanft einblenden — ohne
  // dass jede Seite Klassen setzen muss. Fällt sauber zurück (kein IO / reduzierte Bewegung).
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var nodes = document.querySelectorAll('.sec-head, .pain, .how-card, .mod, .plan, .calc-card, .cmp-wrap, .cta-band, .form, .matrix, .faq-cat, details');
  var targets = [];
  for (var i = 0; i < nodes.length; i++) { nodes[i].classList.add('reveal'); targets.push(nodes[i]); }
  if (!targets.length || reduce || !('IntersectionObserver' in window)) {
    for (var j = 0; j < targets.length; j++) targets[j].classList.add('in');
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  targets.forEach(function (t, idx) {
    // leichte Staffelung innerhalb einer Gruppe
    t.style.transitionDelay = ((idx % 6) * 55) + 'ms';
    io.observe(t);
  });
})();
