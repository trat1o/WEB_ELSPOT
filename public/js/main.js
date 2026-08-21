async function elspotUploadToBlob(file, { handleUploadUrl, pathname }) {
  const { upload } = await import('https://esm.sh/@vercel/blob@2.8.0/client');
  return upload(pathname || file.name, file, { access: 'public', handleUploadUrl });
}

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
        const fileInput = form.querySelector('#quoteAttachment');
        const file = fileInput && fileInput.files[0];
        let attachmentUrl = null;
        let attachmentOriginalName = null;
        if (file) {
          statusEl.textContent = 'Augšupielādē failu...';
          const blob = await elspotUploadToBlob(file, {
            handleUploadUrl: '/quote/blob-upload',
            pathname: 'quote-attachments/' + Date.now() + '-' + file.name,
          });
          attachmentUrl = blob.url;
          attachmentOriginalName = file.name;
        }

        const res = await fetch('/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('quoteName').value,
            contact: document.getElementById('quoteContact').value,
            message: document.getElementById('quoteMessage').value,
            attachmentUrl,
            attachmentOriginalName,
          }),
        });
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

      try {
        const res = await fetch('/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, contact, message }),
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
    });
  }
});
