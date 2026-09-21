/* Relay landing page — progressive enhancement.
   Everything here is optional: with JavaScript off, the page renders complete. */

document.documentElement.classList.add('js');

/* ── Sticky header: glass once the page moves ────────────────────────────── */
const header = document.querySelector('#site-header');
if (header) {
  const syncHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  syncHeader();
  window.addEventListener('scroll', syncHeader, { passive: true });
}

/* ── Scroll-spy: mark the section you're reading in the nav ──────────────── */
const navLinks = [...document.querySelectorAll('.header nav a[href^="#"]')];
const sections = navLinks
  .map((link) => document.getElementById(link.hash.slice(1)))
  .filter(Boolean);

if (sections.length && 'IntersectionObserver' in window) {
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of navLinks) link.removeAttribute('aria-current');
      const active = navLinks.find((link) => link.hash === `#${entry.target.id}`);
      if (active) active.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const section of sections) spy.observe(section);
}

/* ── Reveal on scroll (skipped without IntersectionObserver) ─────────────── */
const reveals = [...document.querySelectorAll('[data-reveal]')];
if (reveals.length) {
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    for (const element of reveals) observer.observe(element);
  } else {
    for (const element of reveals) element.classList.add('is-visible');
  }
}
