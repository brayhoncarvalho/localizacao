'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
 * CONFIG
 * ───────────────────────────────────────────────────────────────────────────── */

// ipwho.is — HTTPS, gratuito, sem chave de API
const IP_API_URL    = 'https://api.ipwho.is/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

/* ─────────────────────────────────────────────────────────────────────────────
 * STATE
 * ───────────────────────────────────────────────────────────────────────────── */

const state = {
  ipData:    null,
  gpsCoords: null,
  gpsAddress: null,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * BOOTSTRAP
 * ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  fetchIPLocation();
  requestGPS();
  renderDeviceCard();
});

// Atualiza IP automaticamente quando a rede mudar
window.addEventListener('online', () => {
  refreshIP();
});

/* ─────────────────────────────────────────────────────────────────────────────
 * IP LOCATION
 * Tenta 3 APIs em cascata para máxima compatibilidade (mobile, Safari, etc.)
 * ───────────────────────────────────────────────────────────────────────────── */

async function fetchWithTimeout(url, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  return Promise.race([fetch(url, { cache: 'no-store' }), timeout]);
}

async function fetchIPLocation() {
  const apis = [
    // 1ª opção: ipwho.is (campos de segurança detalhados)
    async () => {
      const res = await fetchWithTimeout('https://api.ipwho.is/', 10000);
      if (!res.ok) throw new Error(`ipwho.is HTTP ${res.status}`);
      const r = await res.json();
      if (!r.success) throw new Error(r.message || 'ipwho.is sem sucesso');
      return {
        query: r.ip, country: r.country, countryCode: r.country_code,
        regionName: r.region, city: r.city, zip: r.postal,
        lat: r.latitude, lon: r.longitude, timezone: r.timezone?.id,
        isp: r.connection?.isp || r.connection?.org || '',
        org: r.connection?.org || '',
        as: r.connection?.asn ? `AS${r.connection.asn}` : '',
      };
    },
    // 2ª opção: ipinfo.io (excelente suporte iOS/Safari)
    async () => {
      const res = await fetchWithTimeout('https://ipinfo.io/json', 10000);
      if (!res.ok) throw new Error(`ipinfo.io HTTP ${res.status}`);
      const r = await res.json();
      if (r.bogon) throw new Error('ipinfo.io: IP privado/bogon');
      const [lat, lon] = (r.loc || ',').split(',').map(Number);
      return {
        query: r.ip, country: r.country, countryCode: r.country,
        regionName: r.region, city: r.city, zip: r.postal,
        lat: isNaN(lat) ? null : lat, lon: isNaN(lon) ? null : lon,
        timezone: r.timezone,
        isp: r.org || '', org: r.org || '', as: '',
      };
    },
    // 3ª opção: ipapi.co
    async () => {
      const res = await fetchWithTimeout('https://ipapi.co/json/', 10000);
      if (!res.ok) throw new Error(`ipapi.co HTTP ${res.status}`);
      const r = await res.json();
      if (r.error) throw new Error(r.reason || 'ipapi.co erro');
      return {
        query: r.ip, country: r.country_name, countryCode: r.country_code,
        regionName: r.region, city: r.city, zip: r.postal,
        lat: r.latitude, lon: r.longitude, timezone: r.timezone,
        isp: r.org || '', org: r.org || '', as: r.asn || '',
      };
    },
    // 4ª opção: freeipapi.com
    async () => {
      const res = await fetchWithTimeout('https://freeipapi.com/api/json', 10000);
      if (!res.ok) throw new Error(`freeipapi HTTP ${res.status}`);
      const r = await res.json();
      return {
        query: r.ipAddress, country: r.countryName, countryCode: r.countryCode,
        regionName: r.regionName, city: r.cityName, zip: r.zipCode,
        lat: r.latitude, lon: r.longitude, timezone: r.timeZone,
        isp: '', org: '', as: '',
      };
    },
  ];

  let lastErr;
  for (const attempt of apis) {
    try {
      const data = await attempt();
      state.ipData = data;
      renderIPCard(data);
      updateSummary();
      return;
    } catch (e) {
      lastErr = e;
      console.warn('IP API falhou, tentando próxima:', e.message);
    }
  }

  // Todas falharam
  renderIPError(lastErr?.message || 'Todas as APIs falharam');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * GPS
 * ───────────────────────────────────────────────────────────────────────────── */

function requestGPS() {
  if (!navigator.geolocation) {
    showGPSError(2, 'Geolocalização não é suportada por este navegador.');
    return;
  }

  // Mostra estado de aguardo (substitui o botão se ainda existir)
  document.getElementById('gpsBody').innerHTML =
    `<div class="loading-state">` +
    `<div class="spinner spinner--sm"></div>` +
    `<span>Aguardando autorização de localização…</span></div>`;
  setBadge('gpsBadge', 'blue', 'Aguardando…');

  navigator.geolocation.getCurrentPosition(
    onGPSSuccess,
    onGPSError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

/** Atualiza o IP manualmente (usada pelo botão de refresh e evento online). */
function refreshIP() {
  state.ipData = null;
  document.getElementById('ipBody').innerHTML =
    `<div class="loading-state">` +
    `<div class="spinner spinner--sm"></div>` +
    `<span>Atualizando IP…</span></div>`;
  setBadge('ipBadge', '', '');
  fetchIPLocation();
}

async function onGPSSuccess(pos) {
  state.gpsCoords = pos.coords;
  setBadge('gpsBadge', 'blue', 'Obtendo endereço…');

  document.getElementById('gpsBody').innerHTML =
    `<div class="loading-state">` +
    `<div class="spinner spinner--sm"></div>` +
    `<span>Obtendo endereço via Nominatim…</span></div>`;

  try {
    state.gpsAddress = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
  } catch (_) {
    state.gpsAddress = null;
  }

  renderGPSCard(pos.coords, state.gpsAddress);
  updateSummary();
}

function onGPSError(err) {
  showGPSError(err.code, err.message);
}

function showGPSError(code, defaultMsg) {
  const INFO = {
    1: {
      icon: '🚫',
      title: 'Permissão negada',
      msg: 'O usuário não autorizou o acesso à localização. Verifique as permissões do site no navegador.',
      retry: false,
    },
    2: {
      icon: '📵',
      title: 'Localização indisponível',
      msg: defaultMsg || 'Não foi possível determinar a posição. Verifique se o GPS ou localização estão ativados.',
      retry: true,
    },
    3: {
      icon: '⏱️',
      title: 'Tempo limite esgotado',
      msg: 'A solicitação demorou muito. Verifique a conexão ou o sinal GPS e tente novamente.',
      retry: true,
    },
  };

  const info = INFO[code] || { icon: '⚠️', title: 'Erro ao obter GPS', msg: defaultMsg, retry: true };

  document.getElementById('gpsBody').innerHTML =
    `<div class="error-state">` +
    `<span class="error-icon">${info.icon}</span>` +
    `<div><strong>${escHtml(info.title)}</strong>` +
    `<p>${escHtml(info.msg)}</p>` +
    (info.retry ? `<button class="btn-secondary" onclick="retryGPS()">↻ Tentar novamente</button>` : '') +
    `</div></div>`;

  setBadge('gpsBadge', 'red', info.title);
  updateSummary();
}

/** Restore the GPS loading state so the user can try again. */
function retryGPS() {
  state.gpsCoords  = null;
  state.gpsAddress = null;
  requestGPS();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * NOMINATIM — Reverse Geocoding
 * ───────────────────────────────────────────────────────────────────────────── */

async function reverseGeocode(lat, lon) {
  const url =
    `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&addressdetails=1` +
    `&accept-language=pt-BR`;

  const res = await fetch(url, {
    headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — IP Card
 * ───────────────────────────────────────────────────────────────────────────── */

function renderIPCard(d) {
  document.getElementById('ipBody').innerHTML = `
    <div class="data-grid">
      <div class="data-item">
        <span class="data-label">IP Público</span>
        <span class="data-value data-value--mono data-value--highlight">
          ${escHtml(d.query)}
          <button class="copy-btn" onclick="copyText('${escHtml(d.query)}', this)" title="Copiar IP">📋</button>
        </span>
      </div>
      <div class="data-item">
        <span class="data-label">Fuso Horário</span>
        <span class="data-value">${escHtml(d.timezone) || '—'}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Cidade</span>
        <span class="data-value">${escHtml(d.city) || '—'}</span>
      </div>
      <div class="data-item">
        <span class="data-label">CEP / ZIP</span>
        <span class="data-value data-value--mono">${escHtml(d.zip) || '—'}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Estado / Região</span>
        <span class="data-value">${escHtml(d.regionName) || '—'}</span>
      </div>
      <div class="data-item">
        <span class="data-label">País</span>
        <span class="data-value">${escHtml(d.country) || '—'} ${countryFlag(d.countryCode)}</span>
      </div>
      <div class="data-item data-item--full">
        <span class="data-label">Coordenadas (aproximadas pelo IP)</span>
        <span class="data-value data-value--mono">
          ${formatCoord(d.lat)}, ${formatCoord(d.lon)}
          <button class="copy-btn" onclick="copyText('${formatCoord(d.lat)}, ${formatCoord(d.lon)}', this)" title="Copiar">📋</button>
        </span>
      </div>
      <div class="data-item data-item--full" style="margin-top:4px">
        <button class="btn-secondary" onclick="refreshIP()" style="font-size:0.78rem;padding:5px 12px">
          ↻ Atualizar IP
        </button>
      </div>
    </div>`;

  setBadge('ipBadge', 'green', 'Obtido');
}

function renderIPError(msg) {
  document.getElementById('ipBody').innerHTML =
    `<div class="error-state">` +
    `<span class="error-icon">⚠️</span>` +
    `<div><strong>Não foi possível obter dados de IP</strong>` +
    `<p>${escHtml(msg)}</p>` +
    `<button class="btn-secondary" onclick="refreshIP()">\u21bb Tentar novamente</button>` +
    `</div></div>`;

  setBadge('ipBadge', 'red', 'Erro');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — GPS Card
 * ───────────────────────────────────────────────────────────────────────────── */

function renderGPSCard(coords, nominatim) {
  let addressRow = '';
  if (nominatim && nominatim.address) {
    const a = nominatim.address;
    const parts = [
      a.road,
      a.suburb || a.neighbourhood,
      a.city || a.town || a.village || a.municipality,
      a.state,
      a.postcode,
      a.country,
    ].filter(Boolean);
    addressRow =
      `<div class="data-item data-item--full">` +
      `<span class="data-label">Endereço (Nominatim / OSM)</span>` +
      `<span class="data-value">${escHtml(parts.join(', '))}</span></div>`;
  }

  const altRow = (coords.altitude !== null && coords.altitude !== undefined)
    ? `<div class="data-item"><span class="data-label">Altitude</span>` +
      `<span class="data-value">${Math.round(coords.altitude)} m</span></div>`
    : '';

  const coordStr = `${formatCoord(coords.latitude)}, ${formatCoord(coords.longitude)}`;

  document.getElementById('gpsBody').innerHTML = `
    <div class="data-grid">
      <div class="data-item">
        <span class="data-label">Latitude</span>
        <span class="data-value data-value--mono">${formatCoord(coords.latitude)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Longitude</span>
        <span class="data-value data-value--mono">${formatCoord(coords.longitude)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Precisão</span>
        <span class="data-value">±${Math.round(coords.accuracy)} metros</span>
      </div>
      ${altRow}
      <div class="data-item data-item--full">
        <span class="data-label">Coordenadas completas</span>
        <span class="data-value data-value--mono">
          ${escHtml(coordStr)}
          <button class="copy-btn" onclick="copyText('${escHtml(coordStr)}', this)" title="Copiar">📋</button>
        </span>
      </div>
      ${addressRow}
    </div>`;

  setBadge('gpsBadge', 'green', 'Obtido');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — Summary Banner
 * ───────────────────────────────────────────────────────────────────────────── */

function updateSummary() {
  const hasGPS = state.gpsCoords && state.gpsAddress;
  const hasIP  = state.ipData !== null;

  if (!hasGPS && !hasIP) return;

  let location, source;

  if (hasGPS) {
    const a = state.gpsAddress.address;
    const city    = a.city || a.town || a.village || a.municipality || a.county || '';
    const region  = a.state || '';
    const country = a.country || '';
    location = [city, region, country].filter(Boolean).join(', ');
    source = 'gps';
  } else {
    const d = state.ipData;
    location = [d.city, d.regionName, d.country].filter(Boolean).join(', ');
    source = 'ip';
  }

  document.getElementById('summaryLoading').classList.add('hidden');
  document.getElementById('summaryContent').classList.remove('hidden');
  document.getElementById('summaryLocation').textContent = location;

  document.getElementById('summaryMeta').innerHTML =
    `<span class="confidence-badge confidence-badge--${source === 'gps' ? 'blue' : 'yellow'}">` +
    `${source === 'gps' ? '\ud83d\udccd GPS' : '\ud83c\udf10 IP'}</span>` +
    `<span class="confidence-text">${source === 'gps' ? 'Alta precis\u00e3o via GPS' : 'Precis\u00e3o aproximada via IP'}</span>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * UTILITIES
 * ───────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — Device Card
 * ───────────────────────────────────────────────────────────────────────────── */

function renderDeviceCard() {
  // ── User Agent parsing ───────────────────────────────────────────────────
  const ua  = navigator.userAgent;
  let browser = 'Desconhecido', browserVer = '', os = 'Desconhecido';

  // Browser
  if (/Edg\/(\S+)/.test(ua))            { browser = 'Microsoft Edge';  browserVer = RegExp.$1; }
  else if (/Chrome\/(\S+)/.test(ua))    { browser = 'Chrome';          browserVer = RegExp.$1; }
  else if (/Firefox\/(\S+)/.test(ua))   { browser = 'Firefox';         browserVer = RegExp.$1; }
  else if (/Safari\/(\S+)/.test(ua) && !/Chrome/.test(ua)) {
    browser = 'Safari';
    const m = ua.match(/Version\/(\S+)/);
    browserVer = m ? m[1] : '';
  } else if (/OPR\/(\S+)|Opera\/(\S+)/.test(ua)) { browser = 'Opera'; browserVer = RegExp.$1 || RegExp.$2; }

  // OS
  if (/Windows NT 10\.0/.test(ua))      os = 'Windows 10 / 11';
  else if (/Windows NT 6\.3/.test(ua))  os = 'Windows 8.1';
  else if (/Windows NT 6\.1/.test(ua))  os = 'Windows 7';
  else if (/Windows/.test(ua))          os = 'Windows';
  else if (/Android (\d+[\.\d]*)/.test(ua)) os = `Android ${RegExp.$1}`;
  else if (/iPhone OS ([\d_]+)/.test(ua))   os = `iOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/iPad.*OS ([\d_]+)/.test(ua))    os = `iPadOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/Mac OS X ([\d_]+)/.test(ua))    os = `macOS ${RegExp.$1.replace(/_/g,'.')}`;
  else if (/Linux/.test(ua))            os = 'Linux';

  // ── Hardware ─────────────────────────────────────────────────────────────
  const cores  = navigator.hardwareConcurrency || '—';
  const ram    = navigator.deviceMemory        ? `~${navigator.deviceMemory} GB` : '—';
  const touch  = navigator.maxTouchPoints > 0 ? `Sim (${navigator.maxTouchPoints} pontos)` : 'Não';
  const lang   = navigator.language || '—';
  const langs  = navigator.languages ? navigator.languages.join(', ') : lang;
  const dpr    = window.devicePixelRatio || 1;
  const screen_info = `${screen.width} × ${screen.height} px (DPR ${dpr.toFixed(1)})`;
  const colorDepth  = `${screen.colorDepth}-bit`;
  const cookiesOk   = navigator.cookieEnabled ? 'Habilitados' : 'Desabilitados';
  const doNotTrack  = navigator.doNotTrack === '1' ? 'Ativado' : navigator.doNotTrack === '0' ? 'Desativado' : 'Não definido';

  document.getElementById('deviceBody').innerHTML = `
    <div class="data-grid data-grid--wide">
      <div class="data-item">
        <span class="data-label">Navegador</span>
        <span class="data-value">${escHtml(browser)} <span class="data-value--mono" style="font-size:.76rem">${escHtml(browserVer)}</span></span>
      </div>
      <div class="data-item">
        <span class="data-label">Sistema Operacional</span>
        <span class="data-value">${escHtml(os)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">CPU (threads)</span>
        <span class="data-value">${escHtml(String(cores))}</span>
      </div>
      <div class="data-item">
        <span class="data-label">RAM (aproximada)</span>
        <span class="data-value">${escHtml(ram)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Resolução / DPR</span>
        <span class="data-value data-value--mono">${escHtml(screen_info)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Profundidade de cor</span>
        <span class="data-value">${escHtml(colorDepth)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Toque</span>
        <span class="data-value">${escHtml(touch)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Cookies</span>
        <span class="data-value">${escHtml(cookiesOk)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Idioma(s)</span>
        <span class="data-value">${escHtml(langs)}</span>
      </div>
      <div class="data-item">
        <span class="data-label">Do Not Track</span>
        <span class="data-value">${escHtml(doNotTrack)}</span>
      </div>
      <div class="data-item data-item--full">
        <span class="data-label">User Agent</span>
        <span class="data-value data-value--mono" style="font-size:.72rem;word-break:break-all">${escHtml(ua)}</span>
      </div>
    </div>`;
}

function formatCoord(v) {
  return typeof v === 'number' ? v.toFixed(6) : '—';
}

/** ISO 3166-1 alpha-2 → emoji flag (Unicode regional indicators). */
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return [...code.toUpperCase()]
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('');
}

function setBadge(id, color, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className  = color ? `badge badge--${color}` : 'badge';
  el.textContent = text;
}

/** Escape user-supplied strings before injecting into innerHTML. */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Copy text to clipboard and flash the button label. */
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {});
}
