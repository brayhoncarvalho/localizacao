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
  fpData:    null,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * BOOTSTRAP
 * ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  fetchIPLocation();
  requestGPS();
  renderDeviceCard();
  renderFingerprintCard();
});

// Atualiza IP automaticamente quando a rede mudar
window.addEventListener('online', () => {
  refreshIP();
});

// Detecta retorno à aba (ex: usuário trocou VPN em outro app e voltou)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.ipData) {
    refreshIP();
  }
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
    // 5ª opção: ipify (só retorna o IP) + geojs para geolocalização — muito tolerante com VPN
    async () => {
      const [rIp, rGeo] = await Promise.all([
        fetchWithTimeout('https://api.ipify.org?format=json', 8000).then(r => r.json()),
        fetchWithTimeout('https://get.geojs.io/v1/ip/geo.json', 8000).then(r => r.json()),
      ]);
      return {
        query: rIp.ip, country: rGeo.country, countryCode: rGeo.country_code,
        regionName: rGeo.region, city: rGeo.city, zip: '',
        lat: parseFloat(rGeo.latitude) || null, lon: parseFloat(rGeo.longitude) || null,
        timezone: rGeo.timezone, isp: rGeo.organization_name || '', org: '', as: '',
      };
    },
    // 6ª opção: ipify puro (garantia mínima — mostra só o IP mesmo sem geoloc)
    async () => {
      const r = await fetchWithTimeout('https://api.ipify.org?format=json', 8000).then(res => res.json());
      return {
        query: r.ip, country: '—', countryCode: '', regionName: '', city: 'VPN ativa (geoloc indisponível)',
        zip: '', lat: null, lon: null, timezone: '', isp: '', org: '', as: '',
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

  // Todas falharam — tenta uma vez mais após 5s antes de exibir erro
  renderIPRetrying();
  await new Promise(r => setTimeout(r, 5000));
  for (const attempt of apis) {
    try {
      const data = await attempt();
      state.ipData = data;
      renderIPCard(data);
      updateSummary();
      return;
    } catch (e) {
      lastErr = e;
    }
  }

  // Após retry também falhou
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

function renderIPRetrying() {
  document.getElementById('ipBody').innerHTML =
    `<div class="loading-state">` +
    `<div class="spinner spinner--sm"></div>` +
    `<span>Rede instável, tentando novamente em 5s…</span></div>`;
  setBadge('ipBadge', 'yellow', 'Reconectando');
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

    // Bairro e CEP do OSM são frequentemente incorretos no Brasil —
    // exibimos apenas os campos de alta confiança (rua, cidade, estado, país)
    const street = [a.house_number, a.road].filter(Boolean).join(', ');
    const city   = a.city || a.town || a.village || a.municipality || a.county || '';
    const parts  = [street, city, a.state, a.country].filter(Boolean);

    // CEP e bairro exibidos separadamente com aviso de baixa confiança
    const bairro = a.suburb || a.neighbourhood || '';
    const cep    = a.postcode || '';

    const extraRows = [
      bairro ? `<div class="data-item"><span class="data-label">Bairro <span style="font-size:.65rem;color:var(--yellow)" title="Dado OSM pode estar desatualizado">⚠ OSM</span></span><span class="data-value">${escHtml(bairro)}</span></div>` : '',
      cep    ? `<div class="data-item"><span class="data-label">CEP <span style="font-size:.65rem;color:var(--yellow)" title="Dado OSM pode estar desatualizado">⚠ OSM</span></span><span class="data-value data-value--mono">${escHtml(cep)}</span></div>` : '',
    ].join('');

    addressRow =
      `<div class="data-item data-item--full">` +
      `<span class="data-label">Endereço (Nominatim / OSM)</span>` +
      `<span class="data-value">${escHtml(parts.join(', '))}</span></div>` +
      extraRows;
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

/* ─────────────────────────────────────────────────────────────────────────────
 * DEVICE MODEL DETECTION
 * Combina UA · userAgentData · platform · screen · DPR · maxTouchPoints · cores
 * ───────────────────────────────────────────────────────────────────────────── */

async function detectDeviceModel() {
  const ua    = navigator.userAgent;
  const w     = screen.width;
  const h     = screen.height;
  const dpr   = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 0;
  const touch = navigator.maxTouchPoints || 0;
  const plat  = navigator.platform || '';

  // ── Android: Client Hints (Chrome 90+) — retorna modelo exato ────────────
  if (/Android/i.test(ua) && navigator.userAgentData) {
    try {
      const hints = await navigator.userAgentData.getHighEntropyValues(
        ['model', 'platform', 'platformVersion']
      );
      if (hints.model && hints.model.trim() !== '') {
        return { model: hints.model.trim(), confidence: 'Alta', method: 'Client Hints (exato)' };
      }
    } catch (_) { /* fallback abaixo */ }
  }

  // ── Android: parse do User-Agent ─────────────────────────────────────────
  if (/Android/i.test(ua)) {
    // Padrão: "Android X.X; ModeloAqui Build/" ou "Android X.X; ModeloAqui)"
    const m = ua.match(/Android[\s\/][\d.]+;\s*([^)]+?)\s*(?:Build\/|[);])/);
    if (m && m[1]) {
      const raw = m[1].trim();
      if (!/^(Linux|Android|Mobile|K|)$/.test(raw)) {
        return { model: raw, confidence: 'Média', method: 'User-Agent' };
      }
    }
    return { model: 'Android — modelo não exposto pelo browser', confidence: 'Baixa', method: 'User-Agent' };
  }

  // ── iPad (iPadOS 13+ reporta "Macintosh" no UA — detecta por touch) ───────
  const isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touch >= 4);
  if (isIpad) {
    return { model: _detectIpad(Math.min(w,h), Math.max(w,h), dpr), confidence: 'Média', method: 'Resolução + DPR' };
  }

  // ── iPhone / iPod ─────────────────────────────────────────────────────────
  if (/iPhone|iPod/i.test(ua)) {
    return { model: _detectIphone(Math.min(w,h), Math.max(w,h), dpr, cores), confidence: 'Média', method: 'Resolução + DPR + CPU' };
  }

  // ── Desktop ───────────────────────────────────────────────────────────────
  if (/Win/i.test(plat))   return { model: 'PC / Notebook (Windows)', confidence: 'Baixa', method: 'Platform' };
  if (/Mac/i.test(plat))   return { model: 'Mac / MacBook', confidence: 'Baixa', method: 'Platform' };
  if (/Linux/i.test(plat)) return { model: 'PC / Notebook (Linux)',   confidence: 'Baixa', method: 'Platform' };

  return { model: 'Desconhecido', confidence: 'Baixa', method: '—' };
}

/** Tabela iPhone: [largura-retrato, altura-retrato, DPR, cores-mín, rótulo] */
function _detectIphone(pw, ph, dpr, cores) {
  const d = Math.round(dpr);
  // [pw, ph, dpr, minCores, label]
  const T = [
    [320, 480,  2, 0, 'iPhone 4 / 4s'],
    [320, 568,  2, 0, 'iPhone 5 / 5s / SE (1ª geração)'],
    [375, 667,  2, 0, 'iPhone 6 / 6s / 7 / 8 — ou SE (2ª/3ª geração)'],
    [414, 736,  3, 0, 'iPhone 6 Plus / 6s Plus / 7 Plus / 8 Plus'],
    [375, 812,  3, 0, 'iPhone X / XS / 11 Pro — ou 12 mini / 13 mini'],
    [414, 896,  2, 0, 'iPhone XR / 11'],
    [414, 896,  3, 0, 'iPhone XS Max / 11 Pro Max'],
    [390, 844,  3, 0, 'iPhone 12 / 12 Pro / 13 / 13 Pro / 14'],
    [428, 926,  3, 0, 'iPhone 12 Pro Max / 13 Pro Max / 14 Plus'],
    [393, 852,  3, 0, 'iPhone 14 Pro / 15 / 15 Pro / 16 / 16 Pro'],
    [430, 932,  3, 0, 'iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus / 16 Pro Max'],
  ];
  for (const [tw, th, td, mc, label] of T) {
    if (tw === pw && th === ph && td === d && cores >= mc) return label;
  }
  // fallback sem cores
  for (const [tw, th, td, , label] of T) {
    if (tw === pw && th === ph && td === d) return `${label} (aprox.)`;
  }
  return `iPhone — resolução ${pw}×${ph} DPR ${dpr} não mapeada`;
}

/** Tabela iPad: [largura-retrato, altura-retrato, DPR, rótulo] */
function _detectIpad(pw, ph, dpr) {
  const d = Math.round(dpr);
  const T = [
    [768,  1024, 2, 'iPad / iPad mini (geração antiga)'],
    [744,  1133, 2, 'iPad mini (6ª geração)'],
    [810,  1080, 2, 'iPad (7ª / 8ª / 9ª geração)'],
    [820,  1180, 2, 'iPad (10ª geração) / iPad Air (4ª / 5ª geração)'],
    [834,  1112, 2, 'iPad Air (3ª geração) / iPad Pro 10.5"'],
    [834,  1194, 2, 'iPad Pro 11" (1ª – 4ª geração)'],
    [1024, 1366, 2, 'iPad Pro 12.9" (qualquer geração)'],
  ];
  for (const [tw, th, td, label] of T) {
    if (tw === pw && th === ph && td === d) return label;
  }
  return `iPad — resolução ${pw}×${ph} DPR ${dpr} não mapeada`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — Device Card
 * ───────────────────────────────────────────────────────────────────────────── */

async function renderDeviceCard() {
  // ── User Agent parsing ───────────────────────────────────────────────────
  const ua  = navigator.userAgent;
  let browser = 'Desconhecido', browserVer = '', os = 'Desconhecido';

  // Browser — iOS browsers usam WebKit mas expõem seu token no UA
  if      (/CriOS\/(\S+)/.test(ua))           { browser = 'Chrome (iOS)';     browserVer = RegExp.$1; }
  else if (/FxiOS\/(\S+)/.test(ua))           { browser = 'Firefox (iOS)';    browserVer = RegExp.$1; }
  else if (/EdgiOS\/(\S+)/.test(ua))          { browser = 'Edge (iOS)';       browserVer = RegExp.$1; }
  else if (/OPiOS\/(\S+)/.test(ua))           { browser = 'Opera (iOS)';      browserVer = RegExp.$1; }
  else if (/SamsungBrowser\/(\S+)/.test(ua))  { browser = 'Samsung Internet'; browserVer = RegExp.$1; }
  else if (/Edg\/(\S+)/.test(ua))             { browser = 'Microsoft Edge';   browserVer = RegExp.$1; }
  else if (/Chrome\/(\S+)/.test(ua))          { browser = 'Chrome';           browserVer = RegExp.$1; }
  else if (/Firefox\/(\S+)/.test(ua))         { browser = 'Firefox';          browserVer = RegExp.$1; }
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
  const platRaw = navigator.platform || '—';

  // ── Modelo do dispositivo (async) ─────────────────────────────────────────
  const confColor = { 'Alta': 'green', 'Média': 'yellow', 'Baixa': 'gray' };

  // Renderiza estrutura imediatamente com placeholder para o modelo
  document.getElementById('deviceBody').innerHTML = `
    <div class="data-grid data-grid--wide">
      <div class="data-item data-item--full" id="deviceModelRow">
        <span class="data-label">Modelo do dispositivo</span>
        <span class="data-value"><span class="spinner spinner--sm" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Detectando…</span>
      </div>
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
        <span class="data-label">Platform</span>
        <span class="data-value data-value--mono">${escHtml(platRaw)}</span>
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
      <div class="data-item" id="deviceStorageRow">
        <span class="data-label">Armazenamento (quota)</span>
        <span class="data-value"><span class="spinner spinner--sm" style="display:inline-block;vertical-align:middle;margin-right:4px"></span></span>
      </div>
      <div class="data-item" id="deviceMediaRow">
        <span class="data-label">Câmeras / Microfones</span>
        <span class="data-value"><span class="spinner spinner--sm" style="display:inline-block;vertical-align:middle;margin-right:4px"></span></span>
      </div>
      <div class="data-item data-item--full">
        <span class="data-label">User Agent</span>
        <span class="data-value data-value--mono" style="font-size:.72rem;word-break:break-all">${escHtml(ua)}</span>
      </div>
    </div>`;

  // Preenche modelo assim que detectar
  detectDeviceModel().then(({ model, confidence, method }) => {
    const row = document.getElementById('deviceModelRow');
    if (!row) return;
    const color = confColor[confidence] || 'gray';
    row.innerHTML =
      `<span class="data-label">Modelo do dispositivo</span>` +
      `<span class="data-value" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">` +
      `<strong>${escHtml(model)}</strong>` +
      `<span class="badge badge--${color}" title="Confiança: ${escHtml(confidence)} — via ${escHtml(method)}">${escHtml(confidence)}</span>` +
      `<span style="font-size:.72rem;color:var(--text-muted)">via ${escHtml(method)}</span>` +
      `</span>`;
  });

  // Storage quota
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ quota, usage }) => {
      const el = document.getElementById('deviceStorageRow');
      if (!el) return;
      const gb = v => (v / 1024 ** 3).toFixed(2);
      el.querySelector('.data-value').textContent = `${gb(usage)} GB usados de ${gb(quota)} GB disponíveis`;
    }).catch(() => {
      const el = document.getElementById('deviceStorageRow');
      if (el) el.querySelector('.data-value').textContent = 'Não disponível';
    });
  } else {
    const el = document.getElementById('deviceStorageRow');
    if (el) el.querySelector('.data-value').textContent = 'API não suportada';
  }

  // Media devices (sem solicitar stream)
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const el = document.getElementById('deviceMediaRow');
      if (!el) return;
      const cams = devices.filter(d => d.kind === 'videoinput').length;
      const mics = devices.filter(d => d.kind === 'audioinput').length;
      const spks = devices.filter(d => d.kind === 'audiooutput').length;
      el.querySelector('.data-value').textContent = `${cams} câmera(s) · ${mics} microfone(s) · ${spks} saída(s) de áudio`;
    }).catch(() => {
      const el = document.getElementById('deviceMediaRow');
      if (el) el.querySelector('.data-value').textContent = 'Sem acesso (permissão necessária)';
    });
  } else {
    const el = document.getElementById('deviceMediaRow');
    if (el) el.querySelector('.data-value').textContent = 'API não suportada';
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * FINGERPRINT & AUDITORIA
 * WebGL GPU · Canvas hash · Audio hash · Bateria · Sensores · Timestamp
 * ───────────────────────────────────────────────────────────────────────────── */

async function renderFingerprintCard() {
  const results = await Promise.allSettled([
    _fpWebGL(),
    _fpCanvas(),
    _fpAudio(),
    _fpBattery(),
    _fpSensors(),
  ]);

  const [webgl, canvas, audio, battery, sensors] = results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'Erro' }
  );

  const now   = new Date();
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOff = now.getTimezoneOffset();
  const tzStr = `UTC${tzOff <= 0 ? '+' : '−'}${String(Math.abs(tzOff) / 60).padStart(2, '0')}:${String(Math.abs(tzOff) % 60).padStart(2, '0')}`;

  // Compõe fingerprint ID combinando hashes disponíveis
  const fpRaw   = [canvas.hash || '', audio.hash || '', webgl.renderer || ''].join('|');
  const fpHash  = await _sha256short(fpRaw);

  setBadge('fpBadge', 'blue', fpHash);

  document.getElementById('fpBody').innerHTML = `

    <!-- ── Fingerprint ID ── -->
    <p class="fp-section-title">🆔 Fingerprint ID</p>
    <div class="fp-audit-box" style="margin-bottom:1rem">
      <strong>Hash composto (Canvas + Audio + GPU)</strong>
      ${escHtml(fpHash)} &nbsp;<span style="opacity:.55;font-size:.7rem">SHA-256 truncado (12 chars)</span>
    </div>

    <!-- ── GPU ── -->
    <p class="fp-section-title">🖥️ GPU / WebGL</p>
    <div class="fp-grid">
      <div class="fp-item">
        <span class="fp-label">Vendor</span>
        <span class="fp-value">${escHtml(webgl.vendor || webgl.error || '—')}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Renderer (modelo GPU)</span>
        <span class="fp-value">${escHtml(webgl.renderer || webgl.error || '—')}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Versão WebGL</span>
        <span class="fp-value">${escHtml(webgl.version || '—')}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Max Textura (px)</span>
        <span class="fp-value">${escHtml(String(webgl.maxTexture || '—'))}</span>
      </div>
    </div>

    <!-- ── Hashes ── -->
    <p class="fp-section-title">🔒 Hashes de Hardware</p>
    <div class="fp-hash-row">
      <div class="fp-item">
        <span class="fp-label">Canvas fingerprint</span>
        <span class="fp-value fp-value--mono">${escHtml(canvas.hash || canvas.error || '—')}</span>
        <span style="font-size:.68rem;color:var(--text-muted)">${canvas.hash ? 'Renderização única por GPU+fonte+OS' : ''}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Audio fingerprint</span>
        <span class="fp-value fp-value--mono">${escHtml(audio.hash || audio.error || '—')}</span>
        <span style="font-size:.68rem;color:var(--text-muted)">${audio.hash ? 'Processamento de áudio único por hardware' : ''}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">GPU fingerprint</span>
        <span class="fp-value fp-value--mono">${escHtml(webgl.hash || webgl.error || '—')}</span>
        <span style="font-size:.68rem;color:var(--text-muted)">${webgl.hash ? 'Hash do renderer WebGL' : ''}</span>
      </div>
    </div>

    <!-- ── Bateria ── -->
    <p class="fp-section-title">🔋 Bateria</p>
    <div class="fp-grid">
      ${battery.error
        ? `<div class="fp-item"><span class="fp-label">Status</span><span class="fp-value" style="color:var(--text-muted)">${escHtml(battery.error)}</span></div>`
        : `
      <div class="fp-item">
        <span class="fp-label">Nível</span>
        <span class="fp-value">${escHtml(battery.levelPct)}%
          <span style="font-size:.7rem;margin-left:4px;color:var(--text-muted)">${battery.charging ? '⚡ Carregando' : '🔌 Desconectado'}</span>
        </span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Tempo p/ carregar</span>
        <span class="fp-value">${escHtml(battery.chargingTimeStr)}</span>
      </div>
      <div class="fp-item">
        <span class="fp-label">Tempo restante</span>
        <span class="fp-value">${escHtml(battery.dischargingTimeStr)}</span>
      </div>`
      }
    </div>

    <!-- ── Sensores ── -->
    <p class="fp-section-title">📱 Sensores de Movimento</p>
    <div style="margin-bottom:1rem">
      <div class="fp-sensor-row">
        <span class="fp-sensor-dot fp-sensor-dot--${sensors.motionSupported ? 'green' : 'gray'}"></span>
        <span>Acelerômetro (DeviceMotion): <strong>${sensors.motionSupported ? 'Suportado' : 'Não suportado'}</strong>${sensors.motionPermission ? ` — ${escHtml(sensors.motionPermission)}` : ''}</span>
      </div>
      <div class="fp-sensor-row">
        <span class="fp-sensor-dot fp-sensor-dot--${sensors.orientationSupported ? 'green' : 'gray'}"></span>
        <span>Giroscópio (DeviceOrientation): <strong>${sensors.orientationSupported ? 'Suportado' : 'Não suportado'}</strong></span>
      </div>
      ${sensors.alpha !== null
        ? `<div class="fp-sensor-row">
            <span class="fp-sensor-dot fp-sensor-dot--green"></span>
            <span>Leitura atual — α: <strong>${escHtml(sensors.alpha)}°</strong> &nbsp; β: <strong>${escHtml(sensors.beta)}°</strong> &nbsp; γ: <strong>${escHtml(sensors.gamma)}°</strong></span>
           </div>`
        : ''}
    </div>

    <!-- ── Timestamp de auditoria ── -->
    <p class="fp-section-title">🕐 Timestamp de Auditoria</p>
    <div class="fp-audit-box">
      <strong>Registro do momento de acesso</strong>
      ISO 8601 (UTC):&nbsp;&nbsp; ${escHtml(now.toISOString())}<br>
      Local:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${escHtml(now.toLocaleString('pt-BR'))}<br>
      Fuso horário:&nbsp;&nbsp;&nbsp;&nbsp; ${escHtml(tz)} (${escHtml(tzStr)})<br>
      Unix timestamp:&nbsp;&nbsp; ${now.getTime()}
    </div>
  `;
}

// ── WebGL info ────────────────────────────────────────────────────────────────
async function _fpWebGL() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('WebGL não suportado');

  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
  const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const version  = gl.getParameter(gl.VERSION);
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const extensions = gl.getSupportedExtensions() || [];
  const hash = await _sha256short(vendor + '|' + renderer);
  return { vendor, renderer, version, maxTexture, extensions: extensions.length, hash };
}

// ── Canvas fingerprint ────────────────────────────────────────────────────────
async function _fpCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 280; canvas.height = 60;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1c2128';
  ctx.fillRect(0, 0, 280, 60);

  ctx.font = '18px Arial, sans-serif';
  ctx.fillStyle = '#58a6ff';
  ctx.fillText('Fingerprint 🔑 canvas', 8, 28);

  ctx.font = '13px Georgia, serif';
  ctx.fillStyle = '#3fb950';
  ctx.fillText('Auditoria 1234 @#$!', 8, 50);

  // Formas geométricas para capturar diferenças de renderização
  ctx.beginPath();
  ctx.arc(260, 30, 18, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(248,81,73,0.5)';
  ctx.fill();

  const dataUrl = canvas.toDataURL();
  const hash = await _sha256short(dataUrl);
  return { hash };
}

// ── Audio fingerprint ─────────────────────────────────────────────────────────
async function _fpAudio() {
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
  const osc = ctx.createOscillator();
  const cmp = ctx.createDynamicsCompressor();

  osc.type = 'triangle';
  osc.frequency.value = 10000;
  cmp.threshold.value = -50;
  cmp.knee.value       = 40;
  cmp.ratio.value      = 12;
  cmp.attack.value     = 0;
  cmp.release.value    = 0.25;

  osc.connect(cmp);
  cmp.connect(ctx.destination);
  osc.start(0);

  const buffer = await ctx.startRendering();
  const data   = buffer.getChannelData(0);
  // Pega amostra do meio para estabilidade
  let sum = 0;
  for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
  const raw  = sum.toString();
  const hash = await _sha256short(raw);
  return { hash, raw: sum.toFixed(10) };
}

// ── Bateria ───────────────────────────────────────────────────────────────────
async function _fpBattery() {
  if (!navigator.getBattery) throw new Error('API não disponível neste browser (iOS/Firefox)');
  const bat = await navigator.getBattery();
  const fmt = s => s === Infinity ? '—' : `${Math.floor(s / 60)}min`;
  return {
    levelPct:           Math.round(bat.level * 100),
    charging:           bat.charging,
    chargingTimeStr:    fmt(bat.chargingTime),
    dischargingTimeStr: fmt(bat.dischargingTime),
  };
}

// ── Sensores de movimento ────────────────────────────────────────────────────
async function _fpSensors() {
  const result = {
    motionSupported:      'DeviceMotionEvent'      in window,
    orientationSupported: 'DeviceOrientationEvent' in window,
    motionPermission: null,
    alpha: null, beta: null, gamma: null,
  };

  // iOS 13+ requer permissão explícita
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    result.motionPermission = 'Requer permissão (iOS)';
  } else if (result.orientationSupported) {
    // Tenta ler uma amostra por 500ms
    await new Promise(resolve => {
      const handler = (e) => {
        if (e.alpha !== null) {
          result.alpha = e.alpha?.toFixed(1);
          result.beta  = e.beta?.toFixed(1);
          result.gamma = e.gamma?.toFixed(1);
        }
        window.removeEventListener('deviceorientation', handler);
        resolve();
      };
      window.addEventListener('deviceorientation', handler);
      setTimeout(resolve, 500);
    });
  }
  return result;
}

// ── SHA-256 truncado (12 chars hex) ──────────────────────────────────────────
async function _sha256short(str) {
  const buf    = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

// ── Font detection ────────────────────────────────────────────────────────────
async function _fpFonts() {
  const TEST = [
    'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana',
    'Georgia', 'Comic Sans MS', 'Trebuchet MS', 'Impact', 'Tahoma',
    'Lucida Console', 'Monaco', 'SF Pro Display', 'SF Pro Text', 'Roboto',
    'Ubuntu', 'Segoe UI', 'Calibri', 'Cambria', 'Open Sans',
  ];
  const c   = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const p   = 'mmmmmmmmmmlli';
  ctx.font = `16px monospace`; const wM = ctx.measureText(p).width;
  ctx.font = `16px serif`;     const wS = ctx.measureText(p).width;
  const found = TEST.filter(f => {
    ctx.font = `16px '${f}', monospace`; const w1 = ctx.measureText(p).width;
    ctx.font = `16px '${f}', serif`;     const w2 = ctx.measureText(p).width;
    return w1 !== wM || w2 !== wS;
  });
  return { fonts: found, count: found.length, total: TEST.length };
}

// ── Bot / Emulator / Security detection ───────────────────────────────────────
function _fpBot() {
  const signals = [];

  if (navigator.webdriver === true) {
    signals.push({ label: 'navigator.webdriver = true — Selenium / Puppeteer detectado', severity: 'red' });
  } else {
    signals.push({ label: 'navigator.webdriver = false — não é bot automatizado', severity: 'green' });
  }

  const isMobileUA = /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent);
  if (isMobileUA && navigator.maxTouchPoints === 0) {
    signals.push({ label: 'UA mobile mas maxTouchPoints = 0 — possível emulador ou bot', severity: 'red' });
  }

  if (window.outerWidth === 0 || window.outerHeight === 0) {
    signals.push({ label: 'outerWidth / outerHeight = 0 — browser headless detectado', severity: 'red' });
  }

  const inIframe = (() => { try { return window.self !== window.top; } catch (_) { return true; } })();
  if (inIframe) {
    signals.push({ label: 'Página executando dentro de um <iframe>', severity: 'yellow' });
  } else {
    signals.push({ label: 'Janela principal (não está em iframe)', severity: 'green' });
  }

  const dtOpen = (window.outerWidth - window.innerWidth > 160) ||
                 (window.outerHeight - window.innerHeight > 160);
  if (dtOpen) {
    signals.push({ label: 'DevTools possivelmente aberto (diferença outer↔inner > 160 px)', severity: 'yellow' });
  } else {
    signals.push({ label: 'DevTools não detectado', severity: 'green' });
  }

  const pluginCount = navigator.plugins?.length || 0;
  const isDesktopChrome = !/Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) && /Chrome/.test(navigator.userAgent);
  if (isDesktopChrome && pluginCount === 0) {
    signals.push({ label: `Plugins = 0 em Chrome desktop — comportamento de headless browser`, severity: 'yellow' });
  }

  return { signals };
}

// ── iOS sensor permission ─────────────────────────────────────────────────────
async function requestSensorPermissionIOS() {
  const btn = document.getElementById('sensorPermBtn');
  const row = document.getElementById('sensorPermRow');
  if (btn) { btn.disabled = true; btn.textContent = 'Aguardando…'; }
  try {
    const perm = await DeviceOrientationEvent.requestPermission();
    if (perm === 'granted') {
      if (row) row.innerHTML =
        `<span class="fp-sensor-dot fp-sensor-dot--green"></span>
         <span>Permissão concedida ✓ — aguardando leitura…</span>`;
      const readingRow = document.getElementById('sensorReadingRow');
      window.addEventListener('deviceorientation', function handler(e) {
        if (!readingRow) { window.removeEventListener('deviceorientation', handler); return; }
        readingRow.innerHTML =
          `<div class="fp-sensor-row">
             <span class="fp-sensor-dot fp-sensor-dot--green"></span>
             <span>Leitura em tempo real — α: <strong>${e.alpha?.toFixed(1) ?? '—'}°</strong> &nbsp;
               β: <strong>${e.beta?.toFixed(1) ?? '—'}°</strong> &nbsp;
               γ: <strong>${e.gamma?.toFixed(1) ?? '—'}°</strong></span>
           </div>`;
      });
    } else {
      if (row) row.innerHTML =
        `<span class="fp-sensor-dot fp-sensor-dot--red"></span><span>Permissão negada pelo usuário</span>`;
    }
  } catch (e) {
    if (row) row.innerHTML =
      `<span class="fp-sensor-dot fp-sensor-dot--red"></span><span>Erro: ${escHtml(e.message)}</span>`;
  }
}

// ── Export audit report ───────────────────────────────────────────────────────
function exportAuditReport() {
  const report = {
    generated_at:   new Date().toISOString(),
    fingerprint_id: state.fpData?.fpHash || null,
    ip:             state.ipData,
    gps: state.gpsCoords ? {
      latitude:  state.gpsCoords.latitude,
      longitude: state.gpsCoords.longitude,
      accuracy:  state.gpsCoords.accuracy,
      altitude:  state.gpsCoords.altitude,
    } : null,
    gps_address: state.gpsAddress?.display_name || null,
    fingerprint: state.fpData,
    device: {
      userAgent:           navigator.userAgent,
      platform:            navigator.platform,
      language:            navigator.language,
      languages:           Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory:        navigator.deviceMemory,
      maxTouchPoints:      navigator.maxTouchPoints,
      cookieEnabled:       navigator.cookieEnabled,
      screen: {
        width:      screen.width,
        height:     screen.height,
        dpr:        window.devicePixelRatio,
        colorDepth: screen.colorDepth,
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `auditoria-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const btn  = document.getElementById('themeToggle');
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// ── Haversine distance ────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
