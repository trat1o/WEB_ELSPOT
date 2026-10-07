document.addEventListener('DOMContentLoaded', () => {
  // Mobilās navigācijas pārslēgs
  const burger = document.querySelector('.nav-burger');
  const menu = document.querySelector('.nav-menu');
  if (burger && menu) {
    burger.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // Robotu pārbaude: serveris izsniedz parakstītu talonu, pārlūks fonā atrod SHA-256 atrisinājumu (~1 s).
  let challengePromise = null;
  async function solveChallenge() {
    const res = await fetch('/api/challenge', { cache: 'no-store' });
    const c = await res.json();
    if (!c.ok) throw new Error('challenge');
    const enc = new TextEncoder();
    for (let n = 0; ; n++) {
      const solution = n.toString(36);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(c.token + ':' + solution)));
      let bits = 0;
      for (const b of digest) {
        if (b === 0) { bits += 8; continue; }
        bits += Math.clz32(b) - 24;
        break;
      }
      if (bits >= c.bits) return { token: c.token, solution, at: Date.now() };
    }
  }
  function getChallenge() {
    if (!challengePromise) challengePromise = solveChallenge();
    return challengePromise.then((ch) => {
      if (Date.now() - ch.at > 90 * 60 * 1000) { challengePromise = solveChallenge(); return challengePromise; }
      return ch;
    });
  }
  function warmChallenge() { getChallenge().catch(() => { challengePromise = null; }); }
  document.querySelectorAll('form').forEach((f) => f.addEventListener('focusin', warmChallenge, { once: true }));

  // Pakalpojumu kartiņas ar video: statisks attēls, animācija sākas, uzbraucot ar peli (skārienekrānā — pieskaroties)
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.service-card').forEach((card) => {
    const video = card.querySelector('.service-video');
    if (!video) return;
    const start = () => {
      card.classList.add('is-playing');
      const p = video.play();
      if (p && p.catch) p.catch(() => card.classList.remove('is-playing'));
    };
    const stop = () => {
      video.pause();
      video.load();   // atgriež statisko attēlu (poster)
      card.classList.remove('is-playing');
    };
    card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !reducedMotion) start(); });
    card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stop(); });
    card.addEventListener('click', (e) => { if (e.target.closest('[contenteditable]')) return; if (card.classList.contains('is-playing')) stop(); else start(); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (card.classList.contains('is-playing')) stop(); else start(); }
    });
    card.setAttribute('tabindex', '0');
  });

  // Cenas pieprasījuma logs
  const overlay = document.getElementById('quoteModal');
  const openTriggers = document.querySelectorAll('[data-open-quote]');
  const closeTriggers = document.querySelectorAll('[data-close-quote]');
  const form = document.getElementById('quoteForm');
  const statusEl = document.getElementById('quoteFormStatus');

  function openModal(e) {
    if (e) e.preventDefault();
    if (overlay) overlay.classList.add('open');
    if (menu) menu.classList.remove('open');
    warmChallenge();
  }
  function closeModal() {
    if (overlay) overlay.classList.remove('open');
  }

  openTriggers.forEach((el) => el.addEventListener('click', openModal));
  closeTriggers.forEach((el) => el.addEventListener('click', closeModal));
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      statusEl.textContent = '';
      statusEl.className = 'form-status';
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        statusEl.textContent = 'Notiek drošības pārbaude…';
        const ch = await getChallenge();
        challengePromise = null;   // talons ir vienreizlietojams
        const formData = new FormData(form);
        formData.set('ch_token', ch.token);
        formData.set('ch_solution', ch.solution);
        statusEl.textContent = '';
        const res = await fetch('/quote', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok && data.ok) {
          statusEl.textContent = 'Paldies! Sazināsimies ar jums drīzumā.';
          statusEl.classList.add('ok');
          form.reset();
          setTimeout(closeModal, 1800);
        } else {
          statusEl.textContent = data.error || 'Kļūda nosūtot pieprasījumu.';
          statusEl.classList.add('error');
        }
      } catch (err) {
        statusEl.textContent = 'Kļūda nosūtot pieprasījumu. Mēģini vēlreiz.';
        statusEl.classList.add('error');
      }
      if (submitBtn) submitBtn.disabled = false;
    });
  }

  // Kontakti lapas navigācijas lietotņu izvēlne ("Brauc pie mums")
  const navToggle = document.querySelector('[data-nav-toggle]');
  const navMenu = document.getElementById('navAppMenu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      navMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!navMenu.contains(e.target) && e.target !== navToggle) {
        navMenu.classList.remove('open');
      }
    });
  }

  // Kontakti lapas kontaktforma (izmanto to pašu /quote endpointu)
  const contactForm = document.getElementById('contactForm');
  const contactStatusEl = document.getElementById('contactFormStatus');
  if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      contactStatusEl.textContent = '';
      contactStatusEl.className = 'form-status';

      const name = contactForm.contactName.value;
      const email = contactForm.contactEmail.value;
      const phone = contactForm.contactPhone.value;
      const message = contactForm.contactMessage.value;
      const contact = phone ? `${email} / ${phone}` : email;
      const website = document.getElementById('contactWebsite').value;
      const consent = document.getElementById('contactConsent').checked;
      const submitBtn = contactForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        contactStatusEl.textContent = 'Notiek drošības pārbaude…';
        const ch = await getChallenge();
        challengePromise = null;   // talons ir vienreizlietojams
        contactStatusEl.textContent = '';
        const res = await fetch('/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, contact, message, website, consent, ch_token: ch.token, ch_solution: ch.solution }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          contactStatusEl.textContent = 'Paldies! Sazināsimies ar jums drīzumā.';
          contactStatusEl.classList.add('ok');
          contactForm.reset();
        } else {
          contactStatusEl.textContent = data.error || 'Kļūda nosūtot pieprasījumu.';
          contactStatusEl.classList.add('error');
        }
      } catch (err) {
        contactStatusEl.textContent = 'Kļūda nosūtot pieprasījumu. Mēģini vēlreiz.';
        contactStatusEl.classList.add('error');
      }
      if (submitBtn) submitBtn.disabled = false;
    });
  }
});
