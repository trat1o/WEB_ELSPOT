async function elspotUploadToBlob(file, { handleUploadUrl, pathname, clientPayload }) {
  const { upload } = await import('https://esm.sh/@vercel/blob@2.8.0/client');
  return upload(pathname || file.name, file, { access: 'public', handleUploadUrl, clientPayload });
}

document.addEventListener('DOMContentLoaded', () => {
  const pageSlug = document.body.dataset.pageSlug;
  const savebar = document.getElementById('admSavebar');
  const savebarCount = document.getElementById('admSavebarCount');
  const discardBtn = document.getElementById('admDiscardBtn');
  const saveBtn = document.getElementById('admSaveBtn');
  const toast = document.getElementById('admToast');

  const dirtyFields = new Map();
  let toastTimer = null;

  function showToast(message, isError) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('adm-toast-error', !!isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function updateSavebar() {
    if (!savebar) return;
    const count = dirtyFields.size;
    if (count === 0) {
      savebar.hidden = true;
      return;
    }
    savebar.hidden = false;
    savebarCount.textContent = count === 1 ? '1 nesaglabāta izmaiņa' : count + ' nesaglabātas izmaiņas';
  }

  // ---- Teksta lauki ----
  document.querySelectorAll('[data-field]').forEach((el) => {
    const original = el.innerText;
    el.addEventListener('input', () => {
      const field = el.dataset.field;
      const current = el.innerText;
      if (current !== original) {
        dirtyFields.set(field, current);
        el.classList.add('adm-dirty');
      } else {
        dirtyFields.delete(field);
        el.classList.remove('adm-dirty');
      }
      updateSavebar();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.tagName !== 'P') {
        e.preventDefault();
        el.blur();
      }
    });
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (dirtyFields.size === 0) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saglabā...';
      try {
        const res = await fetch('/admin/api/content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: pageSlug, fields: Object.fromEntries(dirtyFields) }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          dirtyFields.clear();
          document.querySelectorAll('[data-field].adm-dirty').forEach((el) => el.classList.remove('adm-dirty'));
          updateSavebar();
          showToast('Izmaiņas saglabātas.');
        } else {
          showToast(data.error || 'Neizdevās saglabāt izmaiņas.', true);
        }
      } catch (err) {
        showToast('Neizdevās saglabāt izmaiņas.', true);
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Saglabāt izmaiņas';
    });
  }

  if (discardBtn) {
    discardBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  // ---- Attēli ----
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.jpg,.jpeg,.png,.webp,.svg';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  let activeImageField = null;
  let activeImageEl = null;

  document.querySelectorAll('[data-image-field]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeImageField = el.dataset.imageField;
      activeImageEl = el;
      fileInput.value = '';
      fileInput.click();
    });
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file || !activeImageField) return;

    showToast('Augšupielādē attēlu...');
    try {
      const formData = new FormData();
      formData.append('field', activeImageField);
      formData.append('image', file);
      const res = await fetch('/admin/api/image', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok && data.ok) {
        applyImageUrl(activeImageEl, data.url);
        showToast('Attēls atjaunināts.');
      } else {
        showToast(data.error || 'Neizdevās augšupielādēt attēlu.', true);
      }
    } catch (err) {
      showToast('Neizdevās augšupielādēt attēlu.', true);
    }
  });

  function applyImageUrl(el, url) {
    const cacheBusted = url + '?t=' + Date.now();
    if (el.classList.contains('adm-image-btn-hero')) {
      const media = document.querySelector('.hero-media');
      if (!media) return;
      if (media.tagName === 'VIDEO') {
        media.setAttribute('poster', cacheBusted);
      } else {
        media.style.backgroundImage = `url('${cacheBusted}')`;
      }
      return;
    }
    const img = el.querySelector('img');
    if (img) {
      img.src = cacheBusted;
      return;
    }
    // Nav zināma vietējā mērķa (piem., placeholder, kas pārslēdzas uz background-image div) — pārlādē lapu, lai atspoguļotu izmaiņas.
    window.location.reload();
  }

  // ---- Hero video ----
  const videoInput = document.createElement('input');
  videoInput.type = 'file';
  videoInput.accept = '.mp4,.webm,.mov,video/*';
  videoInput.style.display = 'none';
  document.body.appendChild(videoInput);

  let activeVideoField = null;

  document.querySelectorAll('[data-video-field]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeVideoField = el.dataset.videoField;
      videoInput.value = '';
      videoInput.click();
    });
  });

  videoInput.addEventListener('change', async () => {
    const file = videoInput.files[0];
    if (!file || !activeVideoField) return;

    showToast('Augšupielādē video, lūdzu uzgaidi...');
    try {
      const blob = await elspotUploadToBlob(file, {
        handleUploadUrl: '/admin/api/blob-upload',
        pathname: 'uploads/video-' + Date.now() + '-' + file.name,
        clientPayload: JSON.stringify({ kind: 'video' }),
      });
      const res = await fetch('/admin/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: activeVideoField, url: blob.url }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        window.location.reload();
      } else {
        showToast(data.error || 'Neizdevās augšupielādēt video.', true);
      }
    } catch (err) {
      showToast('Neizdevās augšupielādēt video.', true);
    }
  });

  document.querySelectorAll('[data-video-remove-field]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const res = await fetch('/admin/api/video/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: el.dataset.videoRemoveField }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās noņemt video.', true);
        }
      } catch (err) {
        showToast('Neizdevās noņemt video.', true);
      }
    });
  });

  // ---- Produktu ražotāji (pievienot/dzēst) ----
  document.querySelectorAll('[data-manufacturer-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/produkti/manufacturer/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionIndex: btn.dataset.sectionIndex,
            categoryIndex: btn.dataset.categoryIndex,
          }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās pievienot ražotāju.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās pievienot ražotāju.', true);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-manufacturer-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Dzēst šo ražotāju?')) return;
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/produkti/manufacturer/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionIndex: btn.dataset.sectionIndex,
            categoryIndex: btn.dataset.categoryIndex,
            manufacturerIndex: btn.dataset.manufacturerIndex,
          }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās dzēst ražotāju.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās dzēst ražotāju.', true);
        btn.disabled = false;
      }
    });
  });

  // ---- Produktu kategorijas (pievienot/dzēst) ----
  document.querySelectorAll('[data-category-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/produkti/category/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sectionIndex: btn.dataset.sectionIndex }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās pievienot kategoriju.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās pievienot kategoriju.', true);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-category-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm('Dzēst šo kategoriju?')) return;
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/produkti/category/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sectionIndex: btn.dataset.sectionIndex,
            categoryIndex: btn.dataset.categoryIndex,
          }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās dzēst kategoriju.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās dzēst kategoriju.', true);
        btn.disabled = false;
      }
    });
  });

  // ---- Par mums komanda (pievienot/dzēst) ----
  document.querySelectorAll('[data-team-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/par-mums/team/add', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās pievienot darbinieku.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās pievienot darbinieku.', true);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-team-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm('Dzēst šo darbinieku?')) return;
      btn.disabled = true;
      try {
        const res = await fetch('/admin/api/par-mums/team/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberIndex: btn.dataset.memberIndex }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          window.location.reload();
        } else {
          showToast(data.error || 'Neizdevās dzēst darbinieku.', true);
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Neizdevās dzēst darbinieku.', true);
        btn.disabled = false;
      }
    });
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirtyFields.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
});
