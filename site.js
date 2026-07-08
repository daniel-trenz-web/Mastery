/* WERKOS Website — Burger-Menü für Mobilgeräte */
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
})();
