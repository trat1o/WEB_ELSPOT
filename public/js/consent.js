// Sīkdatņu piekrišanas pārvaldība. Izvēle tiek glabāta pašu sīkdatnē "elspot_consent" (180 dienas).
(function () {
  var COOKIE = 'elspot_consent';
  var MAX_AGE = 180 * 24 * 60 * 60;

  function read() {
    var m = document.cookie.match(/(?:^|; )elspot_consent=([^;]*)/);
    if (!m) return null;
    try {
      var d = JSON.parse(decodeURIComponent(m[1]));
      return d && d.v === 1 ? d : null;
    } catch (e) { return null; }
  }
  function write(maps) {
    var value = encodeURIComponent(JSON.stringify({ v: 1, maps: !!maps, t: Date.now() }));
    document.cookie = COOKIE + '=' + value + '; Max-Age=' + MAX_AGE + '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }

  var banner = document.getElementById('cookieBanner');
  var modal = document.getElementById('cookieModal');
  var mapsToggle = document.getElementById('cookieMaps');

  function loadMaps() {
    document.querySelectorAll('iframe[data-map-src]').forEach(function (frame) {
      if (!frame.getAttribute('src')) frame.setAttribute('src', frame.getAttribute('data-map-src'));
      frame.hidden = false;
    });
    document.querySelectorAll('[data-map-consent]').forEach(function (box) { box.hidden = true; });
  }
  function mapsLoaded() {
    return !!document.querySelector('iframe[data-map-src][src]');
  }

  function setBanner(show) { if (banner) banner.hidden = !show; }
  function setModal(show) {
    if (!modal) return;
    modal.hidden = !show;
    if (show) {
      var c = read();
      if (mapsToggle) mapsToggle.checked = !!(c && c.maps);
      var first = modal.querySelector('button, input');
      if (first) first.focus();
    }
  }

  function decide(maps) {
    var hadMaps = mapsLoaded();
    write(maps);
    setBanner(false);
    setModal(false);
    if (maps) loadMaps();
    else if (hadMaps) location.reload();   // atsaukta piekrišana — pārlādējam, lai ārējais saturs tiktu atslēgts
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-cookie], [data-open-cookie-settings], [data-map-load]');
    if (!t) return;
    if (t.hasAttribute('data-map-load')) { loadMaps(); return; }   // vienreizēja ielāde, izvēli neglabā
    if (t.hasAttribute('data-open-cookie-settings')) { setModal(true); return; }
    var action = t.getAttribute('data-cookie');
    if (action === 'accept') decide(true);
    else if (action === 'reject') decide(false);
    else if (action === 'settings') setModal(true);
    else if (action === 'close') { setModal(false); if (!read()) setBanner(true); }
    else if (action === 'save') decide(!!(mapsToggle && mapsToggle.checked));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && !modal.hidden) { setModal(false); if (!read()) setBanner(true); }
  });

  var consent = read();
  if (!consent) setBanner(true);
  else if (consent.maps) loadMaps();
})();
