// Параметры типов облачности. Подобраны по фото-референсам (images/refs, см. images/refs/README.md).
//
// kind:
//   cumulo — ячеистые облака: тело вращения + пузыри-башенки, соседние ячейки сливаются (Cu, Sc, Ac, Cb)
//   sheet  — слоистые: сплошной лист с маской покрытия и рваной/волнистой нижней границей (St, As, Ns)
//   cirrus — перистые: анизотропный шум, вытянутый по ветру, с доменным искажением
//
// defaults — значения слоя, подставляемые при выборе типа (метры, окты).
// Для cumulo размер облаков следует из толщины слоя: R = H / (2·aspect), шаг сетки = R_типичный · spacing.
//   aspect      — высота / ширина облака (humilis ~0.3 — плоские, towering >1 — башни)
//   spacing     — шаг ячеек в радиусах (меньше — плотнее, сливаются в массивы)
//   taper       — сужение к вершине (1 — колонна, <1 — конус)
//   dome        — доля высоты, с которой начинается купол-вершина
//   anvilStart  — доля высоты, где начинается наковальня (0 — нет)
//   anvilSpread — радиус наковальни в радиусах тела
//   billowAmp   — амплитуда клубов (смещение поверхности), доля R
//   billowScale — размер клубов, доля R
//   billowTop / billowBottom — характер края: 1 — клубы, 0 — волокна (верх / низ облака)
//   deck        — сплошная палуба под ячейками (Sc)
// Для sheet/cirrus:
//   cell        — масштаб маски покрытия, м
//   billowScale — масштаб детализации, м
//   rag         — рваность нижней границы (доля мин. толщины)
//   wave        — волнистость основания (доля мин. толщины), As undulatus
//   flat        — плоская верхняя граница
// Общие: density — максимальная плотность, rows — гряды, skew — распределение размеров
//   (>1 — в основном мелкие), smoothTop — гладкая вершина (Cb calvus).

const T = (o) => ({
  aspect: 0.5, spacing: 2.5, taper: 1, dome: 0.5, anvilStart: 0, anvilSpread: 0,
  billowAmp: 0.2, billowScale: 0.3, billowTop: 1, billowBottom: 0.3, deck: 0,
  cell: 0, rag: 0, wave: 0, flat: 0, density: 0.8, rows: 0, skew: 1, smoothTop: 0, ...o,
});

export const CLOUD_TYPES = {
  // Ac: мелкие "барашки" с просветами, рядами/сеткой, края мягкие
  Altocumulus: T({
    label: 'Altocumulus (высококучевые)', kind: 'cumulo',
    defaults: { base: 3500, minT: 150, range: 350, oktas: 5 },
    aspect: 0.35, spacing: 2.1, taper: 0.9, dome: 0.3, billowAmp: 0.25, billowScale: 0.45,
    billowTop: 0.7, billowBottom: 0.45, density: 0.7, rows: 0.6,
  }),
  // Sc: бугристое море, валы с тёмными промежутками, сверху — почти сплошная палуба
  Stratocumulus: T({
    label: 'Stratocumulus (слоисто-кучевые)', kind: 'cumulo',
    defaults: { base: 900, minT: 300, range: 500, oktas: 6 },
    aspect: 0.28, spacing: 1.6, taper: 0.9, dome: 0.4, billowAmp: 0.25, billowScale: 0.45,
    billowTop: 0.8, billowBottom: 0.35, density: 0.8, rows: 0.3, deck: 0.8,
  }),
  // Cu humilis: в 2–3 раза шире высоты, плоское основание, рваные доли
  CumulusHumilis: T({
    label: 'Cumulus Humilis (плоские кучевые)', kind: 'cumulo',
    defaults: { base: 1100, minT: 250, range: 350, oktas: 3 },
    aspect: 0.3, spacing: 3.0, taper: 0.85, dome: 0.0, billowAmp: 0.22, billowScale: 0.4,
    billowTop: 0.9, billowBottom: 0.3, density: 0.85, skew: 1.6,
  }),
  // Cu mediocris: высота ~ ширине, сливаются в массивы, бугристые вершины
  CumulusMediocris: T({
    label: 'Cumulus Mediocris (средние кучевые)', kind: 'cumulo',
    defaults: { base: 1100, minT: 700, range: 900, oktas: 4 },
    aspect: 0.55, spacing: 2.4, taper: 0.8, dome: 0.3, billowAmp: 0.22, billowScale: 0.35,
    density: 0.9, skew: 1.4,
  }),
  // Cu congestus: башни разной высоты из широкого основания, резкая "цветная капуста"
  CumulusCongestus: T({
    label: 'Cumulus Congestus (мощные кучевые)', kind: 'cumulo',
    defaults: { base: 1000, minT: 2000, range: 2500, oktas: 4 },
    aspect: 0.85, spacing: 2.6, taper: 0.7, dome: 0.45, billowAmp: 0.2, billowScale: 0.3,
    density: 0.95, skew: 1.2,
  }),
  CumulusTowering: T({
    label: 'Towering Cumulus (башенные)', kind: 'cumulo',
    defaults: { base: 1000, minT: 4000, range: 3500, oktas: 3 },
    aspect: 1.15, spacing: 2.9, taper: 0.7, dome: 0.6, billowAmp: 0.18, billowScale: 0.28, density: 1.0,
  }),
  // Cb calvus: массивный купол, вершина гладкая (кристаллизация), без наковальни
  CumulonimbusCalvus: T({
    label: 'Cumulonimbus Calvus (лысые Cb)', kind: 'cumulo',
    defaults: { base: 900, minT: 6500, range: 3000, oktas: 3 },
    aspect: 1.1, spacing: 3.3, taper: 0.85, dome: 0.75, billowAmp: 0.16, billowScale: 0.25,
    billowTop: 0.7, billowBottom: 0.25, density: 1.0, skew: 0.7, smoothTop: 0.8,
  }),
  // Cb incus: широкая тонкая наковальня с плоским верхом и волокнистыми краями, снос по ветру
  CumulonimbusIncus: T({
    label: 'Cumulonimbus Incus (Cb с наковальней)', kind: 'cumulo',
    defaults: { base: 900, minT: 8500, range: 2500, oktas: 3 },
    aspect: 1.3, spacing: 4.2, taper: 0.85, dome: 0.97, anvilStart: 0.78, anvilSpread: 3.0,
    billowAmp: 0.15, billowScale: 0.25, billowBottom: 0.25, density: 1.0, skew: 0.6,
  }),
  AnvilHead: T({
    label: 'Anvil Head (наковальня)', kind: 'cumulo',
    defaults: { base: 900, minT: 9000, range: 2000, oktas: 2 },
    aspect: 1.3, spacing: 4.6, taper: 0.85, dome: 0.98, anvilStart: 0.7, anvilSpread: 3.4,
    billowAmp: 0.14, billowScale: 0.25, billowBottom: 0.25, density: 0.9, skew: 0.5,
  }),
  // Ns: бесформенный серый, рваное основание
  Nimbostratus: T({
    label: 'Nimbostratus (слоисто-дождевые)', kind: 'sheet',
    defaults: { base: 700, minT: 2500, range: 2000, oktas: 8 },
    cell: 9000, billowScale: 700, density: 0.85, rag: 0.35, billowTop: 0.25,
  }),
  // As: ровный серый, волнистое основание
  Altostratus: T({
    label: 'Altostratus (высокослоистые)', kind: 'sheet',
    defaults: { base: 3500, minT: 900, range: 1100, oktas: 7 },
    cell: 12000, billowScale: 1200, density: 0.55, rag: 0.05, wave: 0.3, billowTop: 0.15,
  }),
  // St: ровное "море", сверху гладкое
  Stratus: T({
    label: 'Stratus (слоистые)', kind: 'sheet',
    defaults: { base: 300, minT: 200, range: 300, oktas: 8 },
    cell: 5000, billowScale: 500, density: 0.6, rag: 0.12, billowTop: 0.2,
  }),
  NimbostratusFlat: T({
    label: 'Nimbostratus Flat (ровные Ns)', kind: 'sheet',
    defaults: { base: 700, minT: 2500, range: 400, oktas: 8 },
    cell: 15000, billowScale: 900, density: 0.85, flat: 1, billowTop: 0.2,
  }),
  // Ci: тонкие волокна, вытянутые ветром
  Cirrus: T({
    label: 'Cirrus (перистые)', kind: 'cirrus',
    defaults: { base: 8500, minT: 300, range: 700, oktas: 4 },
    cell: 9000, density: 0.35, billowTop: 0,
  }),
};

export const KIND_ID = { cumulo: 0, sheet: 1, cirrus: 2 };

// Короткие обозначения для подписей зон
export const TYPE_ABBR = {
  Altocumulus: 'Ac', Stratocumulus: 'Sc', CumulusHumilis: 'Cu hum', CumulusMediocris: 'Cu med',
  CumulusCongestus: 'Cu con', CumulusTowering: 'TCu', CumulonimbusCalvus: 'Cb cal', CumulonimbusIncus: 'Cb inc',
  AnvilHead: 'Anvil', Nimbostratus: 'Ns', Altostratus: 'As', Stratus: 'St', NimbostratusFlat: 'Ns fl', Cirrus: 'Ci',
};

// Пресет: одна зона (layers, domainKm) или сетка смежных зон (grid [nx, ny], tileKm, zones — слои каждой
// зоны по строкам с севера на юг, blendKm — ширина плавного перехода между зонами).
export const PRESETS = {
  zonesFront: {
    label: 'Зоны: Cu → Cb → Ns (холодный фронт, 3×1)', grid: [3, 1], tileKm: 32, blendKm: 16,
    zones: [
      [{ type: 'CumulusMediocris', oktas: 4 }, { type: 'Cirrus', oktas: 3 }],
      [{ type: 'CumulonimbusIncus', base: 1000, oktas: 3 }],
      [{ type: 'Nimbostratus', base: 800 }],
    ],
  },
  zonesCover: {
    label: 'Зоны: Sc 2/8 → 8/8 (покрытие, 2×1)', grid: [2, 1], tileKm: 32, blendKm: 24,
    zones: [
      [{ type: 'Stratocumulus', oktas: 2 }],
      [{ type: 'Stratocumulus', oktas: 8 }],
    ],
  },
  zonesHeight: {
    label: 'Зоны: Cu humilis → Cu congestus (высоты, 2×1)', grid: [2, 1], tileKm: 32, blendKm: 24,
    zones: [
      [{ type: 'CumulusHumilis', oktas: 3 }],
      [{ type: 'CumulusCongestus', oktas: 4 }],
    ],
  },
  zonesQuad: {
    label: 'Зоны: 2×2 — Cu / Sc / Ac+Ci / St+As', grid: [2, 2], tileKm: 32, blendKm: 14,
    zones: [
      [{ type: 'CumulusMediocris', oktas: 4 }],
      [{ type: 'Stratocumulus', oktas: 6 }],
      [{ type: 'Altocumulus', oktas: 5 }, { type: 'Cirrus', oktas: 4 }],
      [{ type: 'Stratus', oktas: 7 }, { type: 'Altostratus', oktas: 6 }],
    ],
  },
  congestusCirrus: {
    label: 'Мощные кучевые + перистые', domainKm: 32,
    layers: [{ type: 'CumulusCongestus' }, { type: 'Cirrus' }],
  },
  fairWeather: {
    label: 'Кучевые хорошей погоды', domainKm: 24,
    layers: [{ type: 'CumulusHumilis' }, { type: 'Altocumulus', oktas: 2 }],
  },
  mediocris: {
    label: 'Cumulus mediocris', domainKm: 24,
    layers: [{ type: 'CumulusMediocris', oktas: 5 }],
  },
  thunderstorm: {
    label: 'Гроза: Cb с наковальней', domainKm: 64,
    layers: [{ type: 'CumulonimbusIncus' }],
  },
  cbOverDeck: {
    label: 'Cb над слоем Sc (как на фото)', domainKm: 64,
    layers: [
      { type: 'Stratocumulus', base: 500, minT: 250, range: 300, oktas: 6 },
      { type: 'CumulonimbusIncus', base: 1150, oktas: 2 },
    ],
  },
  congestusClose: {
    label: 'Cu congestus крупным планом', domainKm: 24,
    layers: [{ type: 'CumulusCongestus', oktas: 3 }],
    camera: 'closeup',
  },
  multiLayer: {
    label: 'Многоярусная: Sc + Ac + Ci', domainKm: 32,
    layers: [{ type: 'Stratocumulus', oktas: 5 }, { type: 'Altocumulus' }, { type: 'Cirrus', oktas: 3 }],
  },
  scSea: {
    label: 'Море Sc сверху', domainKm: 32,
    layers: [{ type: 'Stratocumulus', oktas: 7 }],
  },
  overcast: {
    label: 'Сплошная: Nimbostratus', domainKm: 32,
    layers: [{ type: 'Nimbostratus' }],
  },
  stratiform: {
    label: 'Слоистая: St + As', domainKm: 32,
    layers: [{ type: 'Stratus', oktas: 6 }, { type: 'Altostratus', oktas: 6 }],
  },
  towering: {
    label: 'Башенные кучевые', domainKm: 48,
    layers: [{ type: 'CumulusTowering' }],
  },
};
