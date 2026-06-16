'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
 * CONFIG
 * ───────────────────────────────────────────────────────────────────────────── */

// ipwho.is — HTTPS, gratuito, sem chave de API
const IP_API_URL    = 'https://api.ipwho.is/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Keywords that suggest the IP belongs to a VPN/proxy/cloud provider.
 * Checked against the combined ISP + Org + AS string (lowercase).
 */
const CLOUD_KEYWORDS = [
  'vpn', 'proxy', 'tunnel', 'anonymi', 'tor', 'onion',
  'cloud', 'hosting', 'datacenter', 'data center', 'colocation', 'colo',
  'digitalocean', 'linode', 'vultr', 'hetzner', 'ovh', 'contabo',
  'amazon', 'google cloud', 'microsoft azure', 'azure', 'amazonaws',
  'cloudflare', 'fastly', 'akamai', 'cdn77', 'server',
];

/**
 * Fabricantes de software de segurança corporativa (EDR, CASB, SWG, SASE).
 * Quando o ISP/Org pertence a esses fornecedores o tráfego pode ser tunelado
 * por endpoint security sem que o usuário perceba como "VPN".
 */
const CORPORATE_SECURITY_KEYWORDS = [
  'trellix', 'musarubra', 'mcafee', 'zscaler', 'cisco', 'umbrella',
  'palo alto', 'fortinet', 'fortigate', 'sophos', 'symantec', 'broadcom',
  'crowdstrike', 'checkpoint', 'netskope', 'iboss', 'skyhigh', 'menlo',
  'proofpoint', 'trend micro', 'eset', 'kaspersky', 'bitdefender',
];

/* ─────────────────────────────────────────────────────────────────────────────
 * STATE
 * ───────────────────────────────────────────────────────────────────────────── */

const state = {
  ipData:     null,
  gpsCoords:  null,
  gpsAddress: null,
  vpnScore:   null,
  vpnSignals: [],
  webrtcIPs:  null,
  isCorporate: false,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * BOOTSTRAP
 * ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  gatherWebRTCIPs();
  fetchIPLocation();
  requestGPS();
  renderDeviceCard();
  renderNetInfoCard();
});

// Atualiza IP automaticamente quando a rede mudar
window.addEventListener('online', () => {
  refreshIP();
});

/* ─────────────────────────────────────────────────────────────────────────────
 * WEBRTC IP LEAK DETECTION
 * Usa RTCPeerConnection + STUN para tentar expor o IP real do dispositivo,
 * mesmo quando há VPN ativa. Muitos browsers modernos bloqueiam esse vazamento,
 * mas ainda é eficaz em boa parte dos casos.
 * ───────────────────────────────────────────────────────────────────────────── */

function gatherWebRTCIPs() {
  if (typeof RTCPeerConnection === 'undefined') {
    state.webrtcIPs = [];
    return;
  }

  const ips = new Set();
  let pc;

  const finish = () => {
    try { if (pc) pc.close(); } catch (_) {}
    state.webrtcIPs = [...ips];
    recalcVPN();
  };

  try {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    // Necessário para gerar candidatos ICE
    pc.createDataChannel('');

    const timeout = setTimeout(finish, 4000);

    pc.onicecandidate = (e) => {
      if (!e || !e.candidate) {
        clearTimeout(timeout);
        finish();
        return;
      }
      // Extrai todos os endereços IPv4 do campo candidate
      const matches = e.candidate.candidate.match(/\b(\d{1,3}\.){3}\d{1,3}\b/g);
      if (matches) matches.forEach(ip => ips.add(ip));
    };

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .catch(() => { clearTimeout(timeout); finish(); });

  } catch (_) {
    state.webrtcIPs = [];
    recalcVPN();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * IP LOCATION (ip-api.com — HTTP free tier)
 * ───────────────────────────────────────────────────────────────────────────── */

async function fetchIPLocation() {
  try {
    // Timeout de 8s para evitar spinner infinito
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    let raw;
    try {
      const res = await fetch(IP_API_URL, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
      if (!raw.success) throw new Error(raw.message || 'Falha na API principal');
    } catch (primaryErr) {
      // Fallback: ipapi.co (HTTPS, gratuito)
      console.warn('ipwho.is falhou, tentando fallback ipapi.co:', primaryErr.message);
      const res2 = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
      if (!res2.ok) throw new Error(`Fallback HTTP ${res2.status}`);
      const fb = await res2.json();
      if (fb.error) throw new Error(fb.reason || 'Fallback falhou');
      // Normaliza ipapi.co para o mesmo formato
      raw = {
        success: true, ip: fb.ip,
        country: fb.country_name, country_code: fb.country_code,
        region: fb.region, city: fb.city, postal: fb.postal,
        latitude: fb.latitude, longitude: fb.longitude,
        timezone: { id: fb.timezone },
        connection: { isp: fb.org, org: fb.org, asn: null },
        security: { proxy: false, hosting: false, vpn: false, tor: false },
        _fallback: true,
      };
    }

    const data = {
      query:       raw.ip,
      country:     raw.country,
      countryCode: raw.country_code,
      regionName:  raw.region,
      city:        raw.city,
      zip:         raw.postal,
      lat:         raw.latitude,
      lon:         raw.longitude,
      timezone:    raw.timezone?.id,
      isp:         raw.connection?.isp,
      org:         raw.connection?.org,
      as:          raw.connection?.asn ? `AS${raw.connection.asn} ${raw.connection.org}` : '',
      proxy:       raw.security?.proxy   ?? false,
      hosting:     raw.security?.hosting ?? false,
      vpnFlag:     raw.security?.vpn     ?? false,
      torFlag:     raw.security?.tor     ?? false,
      _fallback:   raw._fallback ?? false,
    };

    state.ipData = data;
    renderIPCard(data);
    recalcVPN();
    updateSummary();

  } catch (err) {
    renderIPError(err.message);
    renderVPNWaiting('Não foi possível obter dados de IP para análise.');
  }
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
  recalcVPN();
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
  recalcVPN();
  updateSummary();
}

/** Restore the GPS loading state so the user can try again. */
function retryGPS() {
  state.gpsCoords  = null;
  state.gpsAddress = null;

  // Redraw map without GPS marker
  if (state.gpsMarker) { state.gpsMarker.remove(); state.gpsMarker = null; }
  if (state.distLine)  { state.distLine.remove();  state.distLine  = null; }

  recalcVPN();
  updateSummary();
  requestGPS(); // Re-dispara o pedido de permissão
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
 * VPN / PROXY SCORE CALCULATION
 *
 * Scoring matrix (max 100 — valores somados e clamped em 100):
 *   +40  proxy=true              — API sinaliza proxy/VPN comercial
 *   +30  hosting=true           — IP de datacenter/hosting
 *   +20  ISP keyword match      — nome do ISP/Org contém termo suspeito
 *   +20  GPS ↔ IP > 100 km      — divergência geográfica (reduzido se corporativo)
 *   +30  GPS ↔ IP > 100 km      — divergência geográfica (sem contexto corporativo)
 *   +35  WebRTC IP leak         — IP real vazou via STUN (reduzido se corporativo)
 *   +45  WebRTC IP leak         — IP real vazou via STUN (sem contexto corporativo)
 *   +15  WebRTC bloqueado       — nenhum IP público exposto via STUN
 *   +25  Timezone mismatch      — fuso do browser ≠ fuso do IP
 *   +15  Idioma vs país         — idioma do browser inconsistente com país do IP
 * ───────────────────────────────────────────────────────────────────────────── */

function recalcVPN() {
  const d = state.ipData;

  if (!d) {
    renderVPNWaiting('Aguardando dados de IP para analisar…');
    return;
  }

  const signals = [];
  let score = 0;

  // Detecta contexto corporativo: ISP/Org pertence a fabricante de sec. software
  const ispRawAll = [d.isp, d.org, d.as].filter(Boolean).join(' ').toLowerCase();
  const corpMatch = CORPORATE_SECURITY_KEYWORDS.find(k => ispRawAll.includes(k));
  const isCorporateCtx = !!corpMatch;

  // ── Signal 0a: VPN flag direto (ipwho.is) ───────────────────────────────
  if (d.vpnFlag === true) {
    signals.push({
      label:    'Campo <code>security.vpn=true</code> (ipwho.is) — IP classificado como VPN pela base de dados',
      severity: 'red', points: 50,
    });
    score += 50;
  }

  // ── Signal 0b: Tor exit node ─────────────────────────────────────────────
  if (d.torFlag === true) {
    signals.push({
      label:    'Campo <code>security.tor=true</code> (ipwho.is) — IP é nó de saída da rede Tor',
      severity: 'red', points: 50,
    });
    score += 50;
  }

  // ── Signal 1: proxy flag ────────────────────────────────────────────────
  if (d.proxy === true) {
    signals.push({
      label:    'Campo <code>proxy=true</code> — IP sinalizado como proxy/VPN ativo pela API',
      severity: 'red', points: 40,
    });
    score += 40;
  } else {
    signals.push({
      label:    'Campo <code>proxy=false</code> — IP não consta nas listas de proxies/VPNs comerciais',
      severity: 'green', points: 0,
    });
  }

  // ── Signal 2: hosting/datacenter flag ───────────────────────────────────
  if (d.hosting === true) {
    signals.push({
      label:    'Campo <code>hosting=true</code> — IP pertence a datacenter ou provedor de hospedagem',
      severity: 'red', points: 30,
    });
    score += 30;
  } else {
    signals.push({
      label:    'Campo <code>hosting=false</code> — IP residencial ou corporativo (não é datacenter)',
      severity: 'green', points: 0,
    });
  }

  // ── Signal 3: ISP / Org keyword match (VPN/cloud) ─────────────────────────
  const matched = CLOUD_KEYWORDS.find(k => ispRawAll.includes(k));
  if (matched) {
    signals.push({
      label: `ISP/Org contém keyword suspeita ("<b>${escHtml(matched)}</b>"): <i>${escHtml(d.isp || d.org)}</i>`,
      severity: 'yellow', points: 20,
    });
    score += 20;
  } else {
    signals.push({
      label: `ISP/Org sem keywords de VPN/cloud: <i>${escHtml(d.isp || d.org || '—')}</i>`,
      severity: 'green', points: 0,
    });
  }

  // ── Signal 3b: Software de segurança corporativa ────────────────────────────
  if (isCorporateCtx) {
    signals.push({
      label: `ISP/Org identificado como fornecedor de segurança corporativa: <b>${escHtml(d.isp || d.org)}</b> ` +
             `— software EDR/CASB/SWG (ex: Trellix, McAfee, Zscaler) pode rotear tráfego sem VPN explícita`,
      severity: 'yellow', points: 0,
    });
  }

  // ── Signal 4: GPS ↔ IP divergence ───────────────────────────────────────
  if (state.gpsCoords) {
    const km = haversineKm(
      state.gpsCoords.latitude, state.gpsCoords.longitude,
      d.lat, d.lon
    );
    if (km > 100) {
      // IPs corporativos/enterprise são alocados pela sede da empresa, não pela
      // localização real do usuário — reduz peso e adiciona aviso de contexto
      const gpsPts = isCorporateCtx ? 20 : 30;
      const note   = isCorporateCtx
        ? ' <small style="opacity:.75">(peso reduzido: geoIP corporativo pode errar por centenas a milhares de km)</small>'
        : '';
      signals.push({
        label: `Divergência GPS ↔ IP: <b>${Math.round(km)} km</b> — acima do limiar de 100 km${note}`,
        severity: isCorporateCtx ? 'yellow' : 'red',
        points: gpsPts,
      });
      score += gpsPts;
    } else {
      signals.push({
        label: `GPS e IP geograficamente próximos: <b>${Math.round(km)} km</b> (limiar: 100 km)`,
        severity: 'green', points: 0,
      });
    }
  } else {
    signals.push({
      label:    'GPS não disponível — verificação de divergência GPS ↔ IP não realizada',
      severity: 'gray', points: 0,
    });
  }

  // ── Signal 5: WebRTC IP leak ─────────────────────────────────────────────
  if (state.webrtcIPs === null) {
    signals.push({
      label:    'WebRTC: coletando IPs via STUN (aguarde ~4s)…',
      severity: 'gray', points: 0, pending: true,
    });
  } else {
    const publicIPs = state.webrtcIPs.filter(ip => !isPrivateIP(ip));
    const apiIP     = d.query;
    const leaked    = publicIPs.filter(ip => ip !== apiIP);

    if (leaked.length > 0) {
      // Contexto corporativo ou CGNAT podem causar dois IPs públicos legítimos
      const wPts  = isCorporateCtx ? 35 : 45;
      const wNote = isCorporateCtx
        ? ' <small style="opacity:.75">(peso reduzido: ambiente corporativo ou CGNAT podem causar IPs distintos sem VPN)</small>'
        : '';
      signals.push({
        label: `WebRTC vazou IP diferente: <code>${escHtml(leaked[0])}</code> ≠ IP público <code>${escHtml(apiIP)}</code>${wNote}`,
        severity: 'red', points: wPts,
      });
      score += wPts;
    } else if (publicIPs.length > 0) {
      signals.push({
        label: `WebRTC: IP STUN (<code>${escHtml(publicIPs[0])}</code>) coincide com IP público — sem vazamento`,
        severity: 'green', points: 0,
      });
    } else {
      signals.push({
        label:    'WebRTC: nenhum IP público exposto via STUN — VPN pode estar bloqueando WebRTC ou browser habilitou proteção de IP',
        severity: 'yellow', points: 15,
      });
      score += 15;
    }
  }

  // ── Signal 6: Timezone mismatch ──────────────────────────────────────────
  const browserTZ = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const ipTZ      = d.timezone || '';
  if (browserTZ && ipTZ) {
    if (browserTZ !== ipTZ) {
      signals.push({
        label: `Fuso horário do browser (<b>${escHtml(browserTZ)}</b>) difere do IP (<b>${escHtml(ipTZ)}</b>) — saída do tráfego em localização diferente`,
        severity: 'yellow', points: 25,
      });
      score += 25;
    } else {
      signals.push({
        label: `Fuso horário consistente: browser e IP em <b>${escHtml(browserTZ)}</b>`,
        severity: 'green', points: 0,
      });
    }
  }

  // ── Signal 7: Language vs country ────────────────────────────────────────
  const lang        = navigator.language || '';
  const langParts   = lang.split('-');
  const langBase    = langParts[0].toUpperCase();
  const langCountry = langParts[1] ? langParts[1].toUpperCase() : '';
  const MULTILANG   = ['EN', 'ES', 'AR', 'ZH', 'FR'];

  if (langCountry && d.countryCode && !MULTILANG.includes(langBase)) {
    if (langCountry !== d.countryCode) {
      signals.push({
        label: `Idioma do browser (<b>${escHtml(lang)}</b>) não coincide com país do IP (<b>${escHtml(d.country)}, ${escHtml(d.countryCode)}</b>)`,
        severity: 'yellow', points: 15,
      });
      score += 15;
    } else {
      signals.push({
        label: `Idioma do browser (<b>${escHtml(lang)}</b>) compatível com país do IP (<b>${escHtml(d.country)}</b>)`,
        severity: 'green', points: 0,
      });
    }
  } else {
    signals.push({
      label: `Idioma (<b>${escHtml(lang || '—')}</b>) — inconclusivo (idioma sem vínculo geográfico único)`,
      severity: 'gray', points: 0,
    });
  }

  state.vpnScore    = Math.min(score, 100);
  state.vpnSignals  = signals;
  state.isCorporate = isCorporateCtx;
  renderVPNCard(state.vpnScore, signals, isCorporateCtx);
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
 * RENDER — VPN Card
 * ───────────────────────────────────────────────────────────────────────────── */

function renderVPNCard(score, signals, isCorporate) {
  const color = scoreColor(score, isCorporate);
  const label = scoreLabel(score, isCorporate);

  document.getElementById('vpnBody').innerHTML = `
    <div class="vpn-score-section">
      <div class="score-bar-wrapper">
        <div class="score-bar">
          <div class="score-fill score-fill--${color}" style="width:0%" id="scoreFill"></div>
        </div>
        <div class="score-info">
          <span class="score-number score-number--${color}">${score}<span class="score-unit">/100</span></span>
          <span class="score-label score-label--${color}">${escHtml(label)}</span>
        </div>
      </div>
    </div>
    <div class="vpn-signals">
      <h3>Sinais analisados</h3>
      <ul class="signal-list">
        ${signals.map(s =>
          `<li class="signal-item signal-item--${s.severity}">` +
          `<span class="signal-dot signal-dot--${s.severity}"></span>` +
          `<span class="signal-text">${s.label}</span>` +
          (s.points > 0 ? `<span class="signal-points">+${s.points}pts</span>` : '') +
          `</li>`
        ).join('')}
      </ul>
    </div>
    <p class="vpn-disclaimer">
      ${isCorporate
        ? '&#9888;&#65039; <b>Ambiente corporativo detectado.</b> O ISP indica software de segurança corporativa (EDR/CASB/SWG como Trellix, McAfee, Zscaler). Isso pode causar IPs distintos no WebRTC e erros de geoIP &mdash; esses sinais <b>não indicam VPN do usuário</b>. O fuso horário (sinal 6) é o indicador mais confiável nesse contexto.'
        : '&#9888;&#65039; Detecção heurística. VPNs corporativas geralmente não são detectadas pelos sinais 1&ndash;3.'}
      Para precisão &gt;95% utilize APIs pagas como
      <a href="https://www.ipqualityscore.com" target="_blank" rel="noopener">IPQualityScore</a> ou
      <a href="https://iphub.info" target="_blank" rel="noopener">IPHub</a>.
    </p>`;

  setBadge('vpnBadge', color, label);

  // Animate the score bar fill after the element is in the DOM
  requestAnimationFrame(() => {
    const fill = document.getElementById('scoreFill');
    if (fill) fill.style.width = `${score}%`;
  });
}

function renderVPNWaiting(msg) {
  document.getElementById('vpnBody').innerHTML =
    `<div class="loading-state">` +
    `<div class="spinner spinner--sm"></div>` +
    `<span>${escHtml(msg || 'Aguardando dados…')}</span></div>`;
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

  const vpnBadgeHtml = state.vpnScore !== null
    ? `<span class="confidence-badge confidence-badge--${scoreColor(state.vpnScore) === 'green' ? 'blue' : scoreColor(state.vpnScore)}">` +
      `VPN Score: ${state.vpnScore}/100</span>`
    : '';

  document.getElementById('summaryMeta').innerHTML =
    `<span class="confidence-badge confidence-badge--${source === 'gps' ? 'blue' : 'yellow'}">` +
    `${source === 'gps' ? '📍 GPS' : '🌐 IP'}</span>` +
    `<span class="confidence-text">${source === 'gps' ? 'Alta precisão via GPS' : 'Precisão aproximada via IP'}</span>` +
    vpnBadgeHtml;
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

/* ─────────────────────────────────────────────────────────────────────────────
 * RENDER — Net Info Card (Network Information API — suporte parcial)
 * ───────────────────────────────────────────────────────────────────────────── */

function renderNetInfoCard() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  if (!conn) {
    document.getElementById('netInfoBody').innerHTML =
      `<p class="note">A Network Information API não é suportada por este navegador (Chrome/Edge Android têm suporte completo; Safari/Firefox têm suporte limitado).</p>`;
    return;
  }

  const typeLabel = { wifi: 'Wi-Fi', cellular: 'Celular/Móvel', ethernet: 'Ethernet / Cabeada',
                      bluetooth: 'Bluetooth', wimax: 'WiMAX', other: 'Outro', none: 'Sem conexão', unknown: 'Desconhecido' };

  const type      = typeLabel[conn.type] || conn.type || '—';
  const eff       = conn.effectiveType ? conn.effectiveType.toUpperCase() : '—';
  const downlink  = conn.downlink  != null ? `${conn.downlink} Mbps` : '—';
  const rtt       = conn.rtt       != null ? `${conn.rtt} ms`  : '—';
  const saveData  = conn.saveData  ? '<span class="pill pill--yellow">Economia de dados ativada</span>' : '<span class="pill pill--green">Normal</span>';

  const updateUI = () => {
    document.getElementById('netInfoBody').innerHTML = `
      <div class="data-grid">
        <div class="data-item">
          <span class="data-label">Tipo de rede</span>
          <span class="data-value">${escHtml(type)}</span>
        </div>
        <div class="data-item">
          <span class="data-label">Qualidade efetiva</span>
          <span class="data-value data-value--mono">${escHtml(eff)}</span>
        </div>
        <div class="data-item">
          <span class="data-label">Velocidade estimada</span>
          <span class="data-value">${escHtml(downlink)}</span>
        </div>
        <div class="data-item">
          <span class="data-label">Latência estimada (RTT)</span>
          <span class="data-value">${escHtml(rtt)}</span>
        </div>
        <div class="data-item data-item--full">
          <span class="data-label">Modo dados</span>
          <span class="data-value">${saveData}</span>
        </div>
      </div>`;
  };

  updateUI();
  // Atualiza se a conexão mudar
  conn.addEventListener('change', updateUI);
}

/** Retorna true se o IP for privado/loopback/link-local. */
function isPrivateIP(ip) {
  return (
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip === '0.0.0.0'
  );
}

/** Haversine great-circle distance in kilometres. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
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

function scoreColor(score, isCorporate) {
  if (isCorporate && score <= 55) return 'yellow'; // ambiente corporativo reduz alarme
  if (score <= 20) return 'green';
  if (score <= 50) return 'yellow';
  return 'red';
}

function scoreLabel(score, isCorporate) {
  if (isCorporate && score <= 55) return 'Rede Corporativa';
  if (score <= 20) return 'Conexão legítima';
  if (score <= 50) return 'Suspeito';
  return 'VPN / Proxy detectado';
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
