// Панель управления (чистый DOM).

const $ = (id) => document.getElementById(id);

function slider(label, min, max, step, value, fmt, onInput, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  wrap.innerHTML = `<div class="ctl-head"><span>${label}</span><b></b></div><input type="range" min="${min}" max="${max}" step="${step}">`;
  const input = wrap.querySelector('input'), out = wrap.querySelector('b');
  input.value = value;
  out.textContent = fmt(+value);
  input.addEventListener('input', () => { out.textContent = fmt(+input.value); onInput(+input.value); });
  if (onChange) input.addEventListener('change', () => onChange(+input.value));
  wrap.set = (v) => { input.value = v; out.textContent = fmt(+v); };
  return wrap;
}

const m = (v) => `${v} м`;

export function buildUI(ctx) {
  const { state, CLOUD_TYPES, PRESETS, MAX_LAYERS } = ctx;

  // --- пресеты
  const presetSel = $('preset');
  presetSel.innerHTML = '<option value="">— выбрать —</option>' +
    Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  presetSel.addEventListener('change', () => { if (presetSel.value) ctx.onPreset(presetSel.value); });

  // --- слои
  const layersEl = $('layers');
  const warn = $('layerWarn');
  const typeOptions = Object.entries(CLOUD_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('');

  function settle() {
    renderZones();
    if (ctx.enforceNonOverlap()) {
      warn.textContent = 'Слои не должны пересекаться по вертикали — нижняя граница поднята.';
      renderLayers();
    } else warn.textContent = '';
    ctx.onLayersChanged();
  }

  function renderLayers() {
    layersEl.innerHTML = '';
    state.layers.forEach((l, idx) => {
      const card = document.createElement('div');
      card.className = 'layer' + (l.enabled ? '' : ' off');
      card.innerHTML = `
        <div class="layer-head">
          <button class="fold" title="Свернуть / развернуть">${l.collapsed ? '▸' : '▾'}</button>
          <label><input type="checkbox" ${l.enabled ? 'checked' : ''}> Слой ${idx + 1}</label>
          <span class="sum"></span>
          <button class="del" title="Удалить слой">✕</button>
        </div>
        <select class="type">${typeOptions}</select>`;
      const sel = card.querySelector('.type');
      sel.value = l.type;
      const top = document.createElement('div');
      top.className = 'muted';
      // свёрнутый слой — одна строка: тип · количество · высоты
      const sum = card.querySelector('.sum');
      const updTop = () => {
        top.textContent = `Верхняя граница до ${ctx.layerTop(l)} м`;
        sum.textContent = `${CLOUD_TYPES[l.type].label.split(' (')[0]} · ${l.oktas}/8 · ${l.base}–${ctx.layerTop(l)} м`;
      };
      card.classList.toggle('folded', !!l.collapsed);
      card.querySelector('.fold').addEventListener('click', () => {
        l.collapsed = !l.collapsed;
        card.classList.toggle('folded', l.collapsed);
        card.querySelector('.fold').textContent = l.collapsed ? '▸' : '▾';
      });
      const live = (key) => (v) => { l[key] = v; updTop(); ctx.onLayersChanged(); renderZones(); };
      card.append(
        slider('Нижняя граница', 0, 12000, 50, l.base, m, live('base'), settle),
        slider('Мин. толщина', 50, 9000, 50, l.minT, m, live('minT'), settle),
        slider('Диапазон толщины', 0, 6000, 50, l.range, m, live('range'), settle),
        slider('Количество (окты)', 1, 8, 1, l.oktas, (v) => `${v}/8`, live('oktas')),
        top,
      );
      updTop();
      card.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        l.enabled = e.target.checked;
        card.classList.toggle('off', !l.enabled);
        settle();
      });
      sel.addEventListener('change', () => {
        Object.assign(l, { type: sel.value }, CLOUD_TYPES[sel.value].defaults);
        ctx.enforceNonOverlap();
        renderLayers();
        ctx.onLayersChanged();
      });
      card.querySelector('.del').addEventListener('click', () => {
        state.layers.splice(idx, 1);
        renderLayers();
        ctx.onLayersChanged();
      });
      layersEl.append(card);
    });
    $('addLayer').disabled = state.layers.length >= MAX_LAYERS;
  }

  $('addLayer').addEventListener('click', () => {
    const top = Math.max(0, ...state.layers.filter((l) => l.enabled).map(ctx.layerTop));
    const type = top < 3000 ? 'Altocumulus' : 'Cirrus';
    const l = ctx.makeLayer(type);
    if (l.base < top + 100) l.base = Math.ceil((top + 200) / 50) * 50;
    state.layers.push(l);
    settle();
    renderLayers();
  });

  // --- ландшафт
  const terrSel = $('terrain'), imgSel = $('imagery');
  terrSel.innerHTML = '<option value="">Процедурная равнина</option>' +
    Object.entries(ctx.LOCATIONS).map(([k, l]) => `<option value="${k}">${l.label}</option>`).join('');
  imgSel.innerHTML = Object.entries(ctx.IMAGERY).map(([k, l]) => `<option value="${k}">${l.label}</option>`).join('');
  terrSel.value = state.terrain; imgSel.value = state.imagery;
  $('raiseClouds').checked = state.raiseClouds;
  terrSel.addEventListener('change', () => { state.terrain = terrSel.value; ctx.onTerrainChanged(); });
  imgSel.addEventListener('change', () => { state.imagery = imgSel.value; if (state.terrain) ctx.onTerrainChanged(); });
  $('raiseClouds').addEventListener('change', (e) => { state.raiseClouds = e.target.checked; });

  // --- динамика: ветер и развитие облаков
  const compass = (d) => ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'][Math.round(d / 45) % 8];
  const windOn = $('windOn'), devOn = $('devOn');
  const wSpeed = slider('Скорость ветра', 0, 40, 1, state.windSpeed, (v) => `${v} м/с`, (v) => { state.windSpeed = v; });
  const wFrom = slider('Ветер дует с', 0, 359, 1, state.windFrom, (v) => `${compass(v)} (${v}°)`,
    (v) => { state.windFrom = v; }, () => ctx.onDynamicsChanged(false));
  const tScale = slider('Ускорение времени', 1, 120, 1, state.timeScale, (v) => `×${v}`, (v) => { state.timeScale = v; });
  $('windCtl').append(wSpeed, wFrom);
  $('timeCtl').append(tScale);
  windOn.checked = state.wind; devOn.checked = state.develop;
  windOn.addEventListener('change', () => { state.wind = windOn.checked; ctx.onDynamicsChanged(true); });
  devOn.addEventListener('change', () => { state.develop = devOn.checked; ctx.onDynamicsChanged(true); });
  const syncDynamics = () => {
    windOn.checked = state.wind; devOn.checked = state.develop;
    wSpeed.set(state.windSpeed); wFrom.set(state.windFrom); tScale.set(state.timeScale);
  };

  // --- атмосфера
  const visToSlider = (v) => Math.log10(v);
  const atmEl = $('atmo');
  const visFmt = (s) => { const v = 10 ** s; return v < 1 ? `${(v * 1000).toFixed(0)} м` : `${v.toFixed(v < 10 ? 1 : 0)} км`; };
  const vis = slider('Видимость (оптическая, МДВ)', -0.7, 2, 0.01, visToSlider(state.visibilityKm), visFmt,
    (s) => { state.visibilityKm = 10 ** s; ctx.onAtmosphereChanged(); });
  atmEl.append(vis);

  // --- солнце
  const sunEl = $('sun');
  const az = slider('Азимут', 0, 360, 1, state.sunAz, (v) => `${v.toFixed(0)}°`, (v) => { state.sunAz = v; ctx.onAtmosphereChanged(); });
  const el = slider('Высота', -5, 90, 0.5, state.sunEl, (v) => `${v}°`, (v) => { state.sunEl = v; ctx.onAtmosphereChanged(); });
  sunEl.append(az, el);
  $('animSun').addEventListener('change', (e) => { state.animateSun = e.target.checked; });

  // --- камера
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => ctx.onCamera(b.dataset.cam)));

  // --- объём
  const bindSel = (id, key, cb) => {
    const s = $(id);
    s.value = String(state[key]);
    s.addEventListener('change', () => { state[key] = +s.value; cb(); });
    return s;
  };
  const domSel = bindSel('domain', 'tileKm', ctx.onVolumeChanged);
  const resHSel = bindSel('resH', 'resH', ctx.onVolumeChanged);
  const resVSel = bindSel('resV', 'resV', ctx.onVolumeChanged);
  const seedIn = $('seed');
  seedIn.value = state.seed;
  seedIn.addEventListener('change', () => { state.seed = +seedIn.value || 0; ctx.onVolumeChanged(); });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 10000);
    seedIn.value = state.seed;
    ctx.onVolumeChanged();
  });

  // --- зоны: смежные density volume с плавным переходом
  const gridSel = $('grid');
  gridSel.value = `${state.grid.nx}x${state.grid.ny}`;
  gridSel.addEventListener('change', () => { const [nx, ny] = gridSel.value.split('x').map(Number); ctx.onGridChanged(nx, ny); });
  const pick = $('zonePick');
  function renderZones() {
    const { nx, ny } = state.grid;
    gridSel.value = `${nx}x${ny}`;
    pick.style.gridTemplateColumns = `repeat(${nx}, 1fr)`;
    pick.innerHTML = '';
    for (let i = 0; i < nx * ny; i++) {
      const b = document.createElement('button');
      b.className = 'zone' + (i === state.sel ? ' sel' : '');
      b.innerHTML = `<b>${String.fromCharCode(65 + (i % nx))}${Math.floor(i / nx) + 1}</b><span>${ctx.zoneLabel(i)}</span>`;
      b.addEventListener('click', () => ctx.onZoneSelect(i));
      pick.append(b);
    }
    $('zoneControls').style.display = nx * ny > 1 ? '' : 'none';
    $('zoneTitle').textContent = nx * ny > 1 ? `— зона ${String.fromCharCode(65 + (state.sel % nx))}${Math.floor(state.sel / nx) + 1}` : '';
  }
  const blend = slider('Ширина перехода между зонами', 0, 30, 0.5, state.blendKm, (v) => `${v} км`,
    (v) => { state.blendKm = v; }, () => ctx.onVolumeChanged());
  $('zoneBlend').append(blend);
  $('copyZone').addEventListener('click', ctx.onCopyZone);
  $('exportZone').addEventListener('click', ctx.onExport);
  const slabSel = $('slabs');
  slabSel.value = state.slabMode;
  slabSel.addEventListener('change', () => { state.slabMode = slabSel.value; ctx.onVolumeChanged(); });

  // --- рендер
  const renEl = $('render');
  const q = $('quality');
  q.value = state.quality;
  q.addEventListener('change', () => { state.quality = q.value; ctx.onRenderChanged(); });
  const rDens = slider('Плотность', 0.1, 3, 0.05, state.densMul, (v) => v.toFixed(2), (v) => { state.densMul = v; ctx.onRenderChanged(); });
  const rExt = slider('Экстинкция, 1/км', 2, 80, 1, state.ext, (v) => v.toFixed(0), (v) => { state.ext = v; ctx.onRenderChanged(); });
  const rEro = slider('Детализация краёв', 0, 1.5, 0.05, state.erode, (v) => v.toFixed(2), (v) => { state.erode = v; ctx.onRenderChanged(); });
  const rExp = slider('Экспозиция', 0.3, 3, 0.05, state.exposure, (v) => v.toFixed(2), (v) => { state.exposure = v; ctx.onAtmosphereChanged(); });
  renEl.append(rDens, rExt, rEro, rExp);
  $('showBox').addEventListener('change', (e) => { state.showBox = e.target.checked; ctx.onRenderChanged(); });
  const clumpSel = $('clump');
  clumpSel.value = String(state.clump);
  clumpSel.addEventListener('change', () => { state.clump = +clumpSel.value; ctx.onVolumeChanged(); });

  $('togglePanel').addEventListener('click', () => document.body.classList.toggle('panel-hidden'));
  $('radarTitle').addEventListener('click', () => document.body.classList.toggle('radar-hidden'));
  // на телефоне панель — шторка, по умолчанию закрыта; выбор пресета или камеры её закрывает
  const mobile = matchMedia('(max-width: 760px)');
  if (mobile.matches) document.body.classList.add('panel-hidden');
  const closeOnMobile = () => { if (mobile.matches) document.body.classList.add('panel-hidden'); };
  presetSel.addEventListener('change', closeOnMobile);
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', closeOnMobile));

  // --- ссылка на конфигурацию
  const shareOut = $('shareOut');
  $('shareBtn').addEventListener('click', ctx.onShare);
  shareOut.addEventListener('focus', () => shareOut.select());

  return {
    refresh() {
      domSel.value = String(state.tileKm); presetSel.value = ''; warn.textContent = '';
      blend.set(state.blendKm); renderLayers(); renderZones();
    },
    syncSun() { az.set(state.sunAz); },
    syncVisibility() { vis.set(visToSlider(state.visibilityKm)); },
    // все элементы панели — по состоянию (после открытия ссылки)
    syncAll() {
      resHSel.value = String(state.resH); resVSel.value = String(state.resV); seedIn.value = state.seed;
      slabSel.value = state.slabMode; q.value = state.quality;
      az.set(state.sunAz); el.set(state.sunEl); $('animSun').checked = state.animateSun;
      vis.set(visToSlider(state.visibilityKm));
      rDens.set(state.densMul); rExt.set(state.ext); rEro.set(state.erode); rExp.set(state.exposure);
      syncDynamics();
      terrSel.value = state.terrain; imgSel.value = state.imagery;
      clumpSel.value = String(state.clump);
    },
    setTerrainStatus(t) { $('terrStatus').textContent = t; },
    showShare(url, copied) {
      shareOut.value = url;
      shareOut.parentElement.style.display = '';
      if (!copied) {                       // запасной способ: выделить поле и скопировать
        shareOut.focus(); shareOut.select();
        try { copied = document.execCommand('copy'); } catch { copied = false; }
      }
      $('shareMsg').textContent = copied ? `Ссылка скопирована (${url.length} символов)` : 'Скопируйте ссылку из поля';
      return copied;
    },
    updateInfo(html) { $('info').innerHTML = html; },
    setHud(text) { $('hud').textContent = text; },
  };
}
