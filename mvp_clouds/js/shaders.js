// GLSL-шейдеры. Все материалы — THREE.ShaderMaterial (WebGL2, GLSL ES 3.0 через префикс three.js).

const noise = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4 hash42(vec2 p) { vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }

float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  float a = hash12(i), b = hash12(i + vec2(1., 0.)), c = hash12(i + vec2(0., 1.)), d = hash12(i + vec2(1., 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3. - 2. * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1., 0., 0.)), n010 = hash13(i + vec3(0., 1., 0.)), n110 = hash13(i + vec3(1., 1., 0.));
  float n001 = hash13(i + vec3(0., 0., 1.)), n101 = hash13(i + vec3(1., 0., 1.)), n011 = hash13(i + vec3(0., 1., 1.)), n111 = hash13(i + vec3(1., 1., 1.));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm2(vec2 p, int oct) {
  float s = 0., a = .5, n = 0.;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoise2(p); n += a; p = p * 2.03 + vec2(13.7, 7.1); a *= .5; }
  return s / n;
}
float fbm3(vec3 p, int oct) {
  float s = 0., a = .5, n = 0.;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoise3(p); n += a; p = p * 2.03 + vec3(13.7, 7.1, 3.3); a *= .5; }
  return s / n;
}
// F1-расстояние Ворлея, ~[0..1]
float worley3(vec3 p) {
  vec3 i = floor(p), f = fract(p); float d = 8.;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(i + o) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
`;

const common = /* glsl */`
precision highp sampler3D;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
vec3 toDisplay(vec3 c, float exposure) { return pow(aces(c * exposure), vec3(1. / 2.2)); }
// Хеньи-Гринштейн, нормирована так, что изотропная = 1
float hg(float c, float g) { float g2 = g * g; return (1. - g2) / pow(max(1. + g2 - 2. * g * c, 1e-4), 1.5); }
// Оптическая толща дымки вдоль луча: коэффициент beta у земли, экспоненциальный спад с высотой
float hazeTau(vec3 ro, vec3 rd, float dist, float beta) {
  const float HS = 1.0;
  float e0 = exp(-max(ro.y, 0.) / HS);
  float k = rd.y / HS;
  if (abs(k) < 1e-4) return beta * e0 * dist;
  return beta * e0 * (1. - exp(-k * dist)) / k;
}
vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1. / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
`;

// Атмосфера Земли: однократное рассеяние Рэлея и Ми (км). Используется для неба;
// те же формулы на JS дают цвет солнца, окружающий свет и цвет дымки (main.js).
const atmosphere = /* glsl */`
const float RE = 6360., RA = 6420., HR = 8., HM = 1.2;
const vec3 BR = vec3(5.8e-3, 13.5e-3, 33.1e-3);
vec2 raySph(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.) return vec2(-1.);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec3 skyRadiance(float altKm, vec3 rd, vec3 sd, float betaM) {
  vec3 ro = vec3(0., RE + max(altKm, .002), 0.);
  float tEnd = raySph(ro, rd, RA).y;
  vec2 tg = raySph(ro, rd, RE);
  if (tg.x > 0.) tEnd = tg.x;
  vec3 sR = vec3(0.), sM = vec3(0.);
  float oR = 0., oM = 0.;
  for (int i = 0; i < 16; i++) {
    float x = (float(i) + .5) / 16.;                  // шаги сгущаются у камеры: t = tEnd·x²
    float ds = tEnd * 2. * x / 16.;
    vec3 p = ro + rd * tEnd * x * x;
    float h = length(p) - RE;
    float hr = exp(-h / HR) * ds, hm = exp(-h / HM) * ds;
    oR += hr; oM += hm;
    if (raySph(p, sd, RE).x > 0.) continue;          // точка в тени Земли
    float dl = raySph(p, sd, RA).y / 6., lR = 0., lM = 0.;
    for (int j = 0; j < 6; j++) {
      float hl = length(p + sd * dl * (float(j) + .5)) - RE;
      lR += exp(-hl / HR) * dl; lM += exp(-hl / HM) * dl;
    }
    vec3 att = exp(-(BR * (oR + lR) + betaM * 1.1 * (oM + lM)));
    sR += att * hr; sM += att * hm;
  }
  float mu = dot(rd, sd);
  float pR = .0597 * (1. + mu * mu);
  float g = .76, g2 = g * g;
  float pM = .1194 * (1. - g2) * (1. + mu * mu) / ((2. + g2) * pow(1. + g2 - 2. * g * mu, 1.5));
  return sR * BR * pR + sM * betaM * pM;
}
`;

// Доступ к density volume в мировой точке (км, y — вверх).
// Мир по горизонтали — атлас смежных зон (s = x, t = z); по вертикали — один или два яруса
// (uVol — нижний, uVolHi — верхний) со своим вертикальным разрешением; граница ярусов uSplitY.
// Динамика: облака из ключевого кадра A сдвинуты по ветру на uShiftA (км), из кадра B — на uShiftB;
// результат — смесь кадров с весом uMixB (при uMixB = 0 кадр B не читается).
const volume = /* glsl */`
uniform sampler3D uVol;
uniform sampler3D uVolHi;
uniform sampler3D uVolB;
uniform sampler3D uVolHiB;
uniform float uSplitY, uMixB;
uniform vec2 uLoY, uHiY, uShiftA, uShiftB;
vec2 volSet(sampler3D lo, sampler3D hi, vec3 p) {
  if (any(lessThan(p, uBoxMin)) || any(greaterThan(p, uBoxMax))) return vec2(0.);
  vec2 xz = (p.xz - uBoxMin.xz) / (uBoxMax.xz - uBoxMin.xz);
  if (p.y < uSplitY) return textureLod(lo, vec3(xz, (p.y - uLoY.x) / (uLoY.y - uLoY.x)), 0.).rg;
  return textureLod(hi, vec3(xz, (p.y - uHiY.x) / (uHiY.y - uHiY.x)), 0.).rg;
}
vec2 volRG(vec3 p) {
  vec2 a = volSet(uVol, uVolHi, p - vec3(uShiftA.x, 0., uShiftA.y));
  if (uMixB <= 0.) return a;
  return mix(a, volSet(uVolB, uVolHiB, p - vec3(uShiftB.x, 0., uShiftB.y)), uMixB);
}
float volD(vec3 p) { return volRG(p).r; }
`;

export const fullscreenVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
`;

export const worldVert = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// ---------------------------------------------------------------------------
// Генерация density volume: один проход = один горизонтальный срез (слой 3D-текстуры RG8).
//   R — плотность 0..1 (0..255), G — "клубистость" края: 1 — кучевые клубы, 0 — волокна/рваные края.
// Координаты в метрах: P.xy — горизонталь, P.z — высота.
// Мир — сетка смежных зон (до 3×3), у каждой свои слои. Одинаковые слои (тип + номер среди слоёв этого типа)
// всех зон образуют одну "группу" — общую популяцию облаков с общей сеткой ячеек и seed. Для группы g и зоны z
// в uGA[g*9+z] хранятся высоты и покрытие (у зоны без такого слоя покрытие 0, высоты — от ближайшего
// подходящего слоя этой зоны). Параметры в точке — билинейная смесь соседних зон с гладким переходом
// шириной uBlend вокруг границ: покрытие, высоты и толщина перетекают непрерывно, шва нет по построению.
// Параметры типа группы g упакованы в 5 vec4:
//   B = (kind, cell, -, density)
//   C = (taper, dome, anvilStart, anvilSpread)
//   D = (billowAmp, billowScale, rag, rows)
//   E = (skew, smoothTop, flat, seed)
//   F = (aspect, billowTop, billowBottom, deck | wave)
// ---------------------------------------------------------------------------
export const genFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uZ;
uniform vec2 uOrigin, uSize;      // область прохода (зона) в метрах мира
uniform vec2 uWorld;              // размер мира, м
uniform vec2 uGrid;               // число зон (nx, ny)
uniform float uTile, uBlend;      // размер зоны и ширина перехода, м
uniform int uNG;                  // число групп
uniform vec2 uWind;
uniform vec4 uGA[72];
uniform vec4 uGB[8];
uniform vec4 uGC[8];
uniform vec4 uGD[8];
uniform vec4 uGE[8];
uniform vec4 uGF[8];
uniform vec4 uGZ[8];              // (zmin, zmax, время жизни облака, с) группы
uniform vec2 uOff;                // снос ветром к моменту кадра, м (облака считаются в сносимой системе координат)
uniform float uTime;              // время кадра, с
uniform float uDev;               // 1 — развитие облаков включено
// Распределение облаков слоя (uGZ[g].w): 0 — равномерно, 1 — случайно, 2 — ближе к центру, 3 — один комок.
// Множитель покрытия в точке мира xy (м) — "вес" места: к центру — крутой гауссов спад (у края почти пусто),
// один комок — плотное скопление в круге ~35% размера мира с чёткой границей и ясным небом вокруг
float clumpK(vec2 xy, float mode) {
  if (mode < 1.5) return 1.;
  float d = length(xy - uWorld * .5) / (.5 * min(uWorld.x, uWorld.y));
  return mode < 2.5 ? 2.6 * exp(-d * d * 4.) : 4. * (1. - smoothstep(.24, .36, d));
}
${noise}

// Высоты и покрытие группы g в горизонтальной точке xy: билинейная смесь 2×2 ближайших зон,
// переход шириной uBlend вокруг каждой границы зон (гладкий, smoothstep)
vec4 blendA(int g, vec2 xy) {
  vec2 t = (xy + uOff) / uTile - .5;                 // зоны неподвижны, облака сносятся через них
  vec2 b = clamp(floor(t), vec2(0.), max(uGrid - 2., vec2(0.)));
  vec2 s = smoothstep(0., 1., clamp((t - b - .5) * uTile / uBlend + .5, 0., 1.));
  if (uGrid.x < 1.5) s.x = 0.;
  if (uGrid.y < 1.5) s.y = 0.;
  ivec2 i0 = ivec2(b), i1 = ivec2(min(b + 1., uGrid - 1.));
  int nx = int(uGrid.x), o = g * 9;
  vec4 a00 = uGA[o + i0.y * nx + i0.x], a10 = uGA[o + i0.y * nx + i1.x];
  vec4 a01 = uGA[o + i1.y * nx + i0.x], a11 = uGA[o + i1.y * nx + i1.x];
  return mix(mix(a00, a10, s.x), mix(a01, a11, s.x), s.y);
}

float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
float coverMask(float w, float cov) { return cov > .99 ? 1. : smoothstep(1. - cov - .12, 1. - cov + .12, w); }
float wfield(vec2 q) { return clamp((fbm2(q, 5) - .5) * 2.4 + .5, 0., 1.); }
// то же с эволюцией во времени (третья координата шума — время в долях жизни облака)
float wfieldT(vec2 q, float life) {
  float f = uDev > 0. ? fbm3(vec3(q, uTime / life), 5) : fbm2(q, 5);
  return clamp((f - .5) * 2.4 + .5, 0., 1.);
}

// Радиус облака (в долях R) на относительной высоте h, <0 — вне облака
float profileR(float h, vec4 C) {
  if (h < 0. || h > 1.) return -1.;
  float r = mix(1., C.x, h);
  if (h > C.y) { float t = (h - C.y) / max(1. - C.y, 1e-3); r *= sqrt(max(0., 1. - t * t)); }
  r *= sqrt(clamp(h / .03 + .7, 0., 1.));           // лёгкое скругление у плоского основания
  if (C.w > 0. && h > C.z) {                        // наковальня: расширение к плоской вершине
    float a = smoothstep(C.z, 1., h);
    float anv = mix(1., C.w, pow(a, 1.3)) * sqrt(clamp((1. - h) / .04 + .3, 0., 1.));   // нижняя поверхность плавно поднимается
    r = max(r, anv);
  }
  return r;
}

// F1-расстояние Ворлея в 2D, ~[0..1]
float worley2(vec2 p) {
  vec2 i = floor(p), f = fract(p); float d = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + hash42(i + o).xy - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}

vec2 cumulo(vec3 P, int li) {
  vec4 B = uGB[li], C = uGC[li], D = uGD[li], E = uGE[li], F = uGF[li];
  vec4 A = blendA(li, P.xy);
  float base = A.x, cov = A.w, seed = E.w, aspect = F.x;
  float G = B.y;
  // органичная форма: координаты искажаются низкочастотным шумом — шары-пузыри становятся неправильными долями.
  // У основания вертикально не искажаем, чтобы дно оставалось плоским.
  vec3 wq = P / (D.y * 2.6) + seed * .9;
  vec3 warp = (vec3(fbm3(wq, 2), fbm3(wq + 5.2, 2), fbm3(wq + 9.7, 2)) - .5) * 1.8 * D.y;
  float zf = clamp((P.z - base) / (A.y * .5 + 1.), 0., 1.);
  vec3 Pw = P + vec3(warp.xy, warp.z * zf);
  float anvTop = C.w > 0. ? fbm2(P.xy / 4000. + seed * .3, 3) : 0.;     // волнистость верха наковальни
  vec2 gi = floor(Pw.xy / G);
  float best = -1e9, bestS = -1e9, bestH = 0., bestAnv = 0., bestBase = base, bestMam = 0., bestDecay = 0.;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 c = gi + vec2(float(i), float(j));
    vec4 r = hash42(c + seed);
    // равномерно — почти правильная сетка без скоплений; иначе — случайный разброс с кластеризацией
    float mode = uGZ[li].w;
    float jit = mode < .5 ? .12 : .8;                          // равномерно — почти точная сетка
    vec2 ctr = (c + .5 - .5 * jit + jit * r.xy) * G;
    float wm = mode < .5 ? .55 : vnoise2(ctr / (G * 3.5) + seed * .13);
    float rows = 1.;
    if (D.w > 0.) {                                             // гряды поперёк ветра
      float s = .5 + .5 * sin(dot(ctr, uWind) / (G * 1.5) * 6.2831853);
      rows = mix(1., s * 1.6, D.w);
    }
    // параметры зон — в центре ячейки: в зоне перехода облако целиком есть или нет, а не режется
    vec4 Ac = blendA(li, ctr);
    // мягкое присутствие: у порога покрытия облако маленькое, а не исчезает скачком (важно при сносе через зоны)
    float grow = smoothstep(-.06, .06, Ac.w * clumpK(ctr + uOff, mode) * 1.25 * (.45 + 1.1 * wm) * rows - r.z);
    if (grow <= 0.) continue;                                    // ячейка пустая
    // жизненный цикл: зарождение → рост вверх и вширь → зрелость → распад; фаза у каждой ячейки своя
    float decay = 0.;
    if (uDev > 0.) {
      float ph = fract(uTime / uGZ[li].z + hash12(c * 5.7 + seed));
      grow *= smoothstep(0., .3, ph) * (1. - smoothstep(.72, 1., ph));
      decay = smoothstep(.65, 1., ph);
      if (grow <= .02) continue;
    }
    // размер облака: много мелких, мало крупных; ширина следует из высоты и пропорций типа
    float sz = pow(r.w, E.x);
    float H = (Ac.y + Ac.z * sz) * mix(.25, 1., grow);
    float R = min(H / (2. * aspect) * mix(.8, 1.25, hash12(c * 1.37 + seed + 5.1)), G * 1.1);
    float dc = length(Pw.xy - ctr);
    if (dc > R * (1.6 + C.w * 1.6)) continue;
    if (C.w > 0.) {
      // наковальня: плато чуть ниже верха слоя с волнистостью, над ядром — купол (overshooting top) до самого верха
      float over = exp(-dc * dc / (R * R) * 4.);
      H *= mix(.93 + .05 * (anvTop - .5), 1., over);
    }
    // уровень конденсации: свой у каждого облака (до 200 м) и плавно меняется по полю (до 120 м); только выше границы слоя
    float bc0 = Ac.x + min(Ac.y * .15, 200.) * hash12(c * 3.1 + seed) + 120. * vnoise2((ctr + uOff) / 20000. + seed * .21);
    float h = (Pw.z - bc0) / H;
    if (h < -.02 || h > 1.) continue;
    // тело: профиль вращения
    vec2 cc = ctr;
    if (C.w > 0.) cc += uWind * R * C.w * .4 * smoothstep(C.z, 1., h);   // снос наковальни ветром
    float s = profileR(max(h, 0.), C) * R * (C.w > 0. && h > C.z ? .85 : .55) - length(Pw.xy - cc);   // >0 — внутри, метры
    // пузыри-доли разного размера и формы, сглаженно объединённые с телом
    float vs = min(1., 1.4 * H / R);                                       // сплюснутость для плоских облаков
    vec3 rel = vec3(Pw.xy - ctr, Pw.z - bc0);
    float hTop = C.w > 0. ? min(C.z + .1, .95) : .9;                      // у Cb пузыри — до основания наковальни
    int nb = int(clamp(8. + 9. * aspect, 12., 20.));                       // башням — больше пузырей по высоте
    for (int k = 0; k < 20; k++) {
      if (k >= nb) break;
      vec4 q = hash42(c * 1.91 + seed + float(k) * 7.31);
      vec2 st = mix(vec2(.75), vec2(1.3), hash42(c * 2.71 + float(k) * 3.17).xy);   // эллипсоид, а не шар
      float hk = k == 0 ? hTop * .95 : mix(.05, hTop, q.x);
      float rk = R * mix(.25, .62, q.y * q.y) * mix(1., C.x, hk) * (aspect > .9 ? .8 : 1.);
      float rz = rk * vs;
      vec3 bc = vec3((q.zw - .5) * R * 1.3 * (1. - .5 * hk), min(max(hk * H, rz * .15), H - rz - D.x * .5));
      vec3 dv = rel - bc; dv.z /= vs; dv.xy *= st;
      s = smax(s, rk - length(dv), .18 * R);
    }
    float mam = 0.;
    if (C.w > 0.) {
      // mammatus: "мешки", свисающие под наковальней вне башни
      float q0 = length(Pw.xy - ctr - uWind * R * C.w * .2) / (.85 * R);
      if (q0 > 1.05) {
        float aa = pow(clamp((q0 - 1.) / (C.w - 1.), 0., 1.), 1. / 1.3);
        if (aa < .92) {
          float x = .5 - sin(asin(1. - 2. * aa) / 3.);                    // обратная smoothstep
          float zu = bc0 + (C.z + x * (1. - C.z)) * H;                    // высота нижней поверхности наковальни
          float mw = worley2(Pw.xy / 1100. + seed);
          float pouch = sqrt(max(0., 1. - mw * mw / .22));
          float pd = 550. * pouch * smoothstep(1.1, 1.6, q0) * (1. - smoothstep(.55, .92, aa));
          float sm = min(P.z - (zu - pd), zu + 120. - P.z);
          if (sm > s) { s = sm; mam = 1.; }
        }
      }
    }
    // сглаженное пересечение с плоскостью основания: дно плоское, но без острого ребра
    float kb = .15 * R * vs + 20.;
    s = -smax(-s, -(P.z - bc0) * 1.5, kb);
    best = smax(best, s, .25 * R);                                         // соседние облака сливаются в массивы
    if (s > bestS) { bestS = s; bestH = max(h, 0.); bestBase = bc0; bestMam = mam; bestDecay = decay; bestAnv = C.w > 0. ? smoothstep(C.z - .05, C.z + .1, h) * (1. - mam) : 0.; }
  }
  float amp = D.x;
  vec2 res = vec2(0.);
  float fb = fbm3(P / (D.y * 1.9) + seed * 1.7, 3);
  if (best > -amp * 1.6) {
    // клубы трёх масштабов: крупные доли, средние и мелкие "цветная капуста"
    vec3 q = Pw / D.y + seed;
    float bill = 1. - (.55 * worley3(q) + .3 * worley3(q * 2.17 + 11.3) + .15 * worley3(q * 4.63 + 3.1));
    float ampH = amp * mix(.45, 1.15, clamp(bestH, 0., 1.));
    ampH *= mix(1., .3, E.y * smoothstep(.55, 1., bestH));
    float s = best + (bill - .45) * ampH + (fb - .5) * ampH * .9;
    float d = smoothstep(0., .3 * amp + 30., s);
    // основание: мягкий переход и лёгкая волнистость (только вверх — облако не опускается ниже слоя)
    // основание плотное и чёткое (там резко появляются капли), с лёгкой волнистостью
    float bn = fbm2(P.xy / (amp * 5. + 200.) + seed * .7, 3) * (amp * .12 + 10.);
    d *= smoothstep(0., .06 * amp + 25., P.z - bestBase - bn);
    d *= B.w * (.7 + .3 * fb) * mix(1., .65, bestAnv);                    // наковальня реже и тоньше
    d *= 1. - .6 * bestDecay;                                             // распадающееся облако редеет
    if (bestAnv > 0.) {
      // волокнистая текстура наковальни, вытянутая по ветру (видна сверху)
      vec2 xy = vec2(dot(P.xy, uWind), dot(P.xy, vec2(-uWind.y, uWind.x)));
      float stk = fbm3(vec3(xy.x / 3500., xy.y / 300., P.z / 250.) + seed, 4);
      d *= mix(1., .45 + 1.1 * stk, bestAnv);
    }
    float bl = mix(F.z, F.y, smoothstep(.05, .5, bestH));                // рыхлый низ, клубящийся верх
    bl = mix(mix(bl, .05, bestAnv), .85, bestMam);                        // наковальня — волокнистая, mammatus — гладкие мешки
    res = vec2(d, mix(bl, .15, bestDecay));                               // и становится рваным
  }
  // палуба под ячейками (Sc): сплошной бугристый слой при большом количестве
  if (F.w > 0.) {
    float m = coverMask(wfield(P.xy / (G * 2.5) + seed * .4), cov * .9);
    float top = base + A.y * .55 * (.7 + .6 * fb);
    float v = smoothstep(base, base + 50., P.z) * (1. - smoothstep(top - 80., top, P.z));
    float dd = v * m * F.w * B.w * .85;
    if (dd > res.x) res = vec2(dd, mix(F.z, F.y, .5));
  }
  return res;
}

vec2 sheet(vec3 P, int li) {
  vec4 B = uGB[li], D = uGD[li], E = uGE[li], F = uGF[li];
  vec4 A = blendA(li, P.xy);
  float base = A.x, cov = A.w, seed = E.w;
  float rag = D.z * A.y, wave = F.w * A.y;
  if (P.z < base - rag - wave - 1. || P.z > base + A.y + A.z + 1.) return vec2(0.);
  vec2 q = P.xy / B.y + seed * .21;
  float mask = coverMask(wfieldT(q, uGZ[li].z), min(cov * clumpK(P.xy + uOff, uGZ[li].w), 1.));
  if (mask <= .001) return vec2(0.);
  float tn = fbm2(q * 2.3 + 7.7, 4);
  float thick = E.z > .5 ? A.y + A.z * (.45 + .1 * tn) : (A.y + A.z * tn) * mix(.35, 1., sqrt(mask));
  float bot = base;
  if (rag > 0.) bot += rag * clamp((fbm3(P / vec3(1200., 1200., 500.) + seed, 3) - .62) * 2., -1., 1.);
  if (wave > 0.)                                     // волнистое основание (undulatus): гряды поперёк ветра
    bot -= wave * (.5 + .5 * sin(dot(P.xy, uWind) / 1600. * 6.2831853 + 4. * fbm2(P.xy / 6000., 2)));
  float top = base + thick;
  float soft = max(35., .12 * thick);
  float v = smoothstep(bot, bot + soft, P.z) * (1. - smoothstep(top - soft, top, P.z));
  if (v <= 0.) return vec2(0.);
  float det = fbm3(P / vec3(D.y * 2.5, D.y * 2.5, D.y) + seed * 1.3, 4);
  float d = v * mask * B.w * (.45 + .55 * det) * smoothstep(.15, .5, mask * det * 1.6);
  return vec2(d, F.y);
}

vec2 cirrus(vec3 P, int li) {
  vec4 B = uGB[li], E = uGE[li];
  vec4 A = blendA(li, P.xy);
  float base = A.x, cov = A.w, seed = E.w;
  if (P.z < base - 1. || P.z > base + A.y + A.z + 1.) return vec2(0.);
  vec2 xy = vec2(dot(P.xy, uWind), dot(P.xy, vec2(-uWind.y, uWind.x)));   // x — вдоль ветра
  vec3 q = vec3(xy.x / 5000., xy.y / 600., (P.z - base) / 400. + uDev * uTime / uGZ[li].z) + seed;
  q.y += 1.4 * fbm3(q * vec3(.6, .25, .8) + 3.1, 3);
  q.x += .5 * fbm3(q * vec3(1., .5, 1.) + 9.2, 2);
  float n = fbm3(q, 5);
  float mask = coverMask(wfieldT(P.xy / B.y + seed * .3, uGZ[li].z), min(cov * clumpK(P.xy + uOff, uGZ[li].w), 1.));
  float thick = A.y + A.z * fbm2(P.xy / 6000. + 4.2, 3);
  float hz = (P.z - base) / thick;
  float v = smoothstep(0., .2, hz) * (1. - smoothstep(.65, 1., hz));
  return vec2(smoothstep(.5, .7, n) * v * mask * B.w, 0.);
}

void main() {
  vec3 P = vec3(uOrigin + vUv * uSize, uZ);
  // плавное затухание к внешним краям мира, чтобы облака не обрезались стенкой
  vec2 e = min(P.xy, uWorld - P.xy);
  float edge = smoothstep(0., 1500., min(e.x, e.y));
  if (edge <= 0.) { gl_FragColor = vec4(0.); return; }
  vec2 d = vec2(0.);
  for (int li = 0; li < 8; li++) {
    if (li >= uNG) break;
    if (P.z < uGZ[li].x - 1. || P.z > uGZ[li].y + 1.) continue;
    float k = uGB[li].x;
    vec3 Pm = P - vec3(uOff, 0.);
    vec2 v = k < .5 ? cumulo(Pm, li) : (k < 1.5 ? sheet(Pm, li) : cirrus(Pm, li));
    if (v.x > d.x) d = v;
  }
  gl_FragColor = vec4(clamp(d.x * edge, 0., 1.), d.y, 0., 1.);
}
`;

// ---------------------------------------------------------------------------
// Тайловая текстура детализации 128^3 (RG8), используется при рендере для эрозии краёв:
//   R — billow: инвертированный fbm Ворлея (клубы), G — wispy: fbm value-noise (волокна, рваные края).
// ---------------------------------------------------------------------------
export const detailFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uZ;
${noise}
float worleyP(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p); float d = 8.;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + hash33(mod(i + o, per)) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
float vnoiseP(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3. - 2. * f);
  float n000 = hash13(mod(i, per)), n100 = hash13(mod(i + vec3(1., 0., 0.), per));
  float n010 = hash13(mod(i + vec3(0., 1., 0.), per)), n110 = hash13(mod(i + vec3(1., 1., 0.), per));
  float n001 = hash13(mod(i + vec3(0., 0., 1.), per)), n101 = hash13(mod(i + vec3(1., 0., 1.), per));
  float n011 = hash13(mod(i + vec3(0., 1., 1.), per)), n111 = hash13(mod(i + vec3(1., 1., 1.), per));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(vUv, uZ);
  float w = .55 * worleyP(p * 4., 4.) + .3 * worleyP(p * 8., 8.) + .15 * worleyP(p * 16., 16.);
  float f = (.5 * vnoiseP(p * 8., 8.) + .25 * vnoiseP(p * 16., 16.) + .125 * vnoiseP(p * 32., 32.) + .0625 * vnoiseP(p * 64., 64.)) / .9375;
  gl_FragColor = vec4(clamp(1. - w * 1.15, 0., 1.), clamp((f - .5) * 1.8 + .5, 0., 1.), 0., 1.);
}
`;

// ---------------------------------------------------------------------------
// Raymarching облаков (мир в км). Рисуется задними гранями бокса объёма.
// ---------------------------------------------------------------------------
export const cloudFrag = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uDetail;
uniform float uDetailScale, uErode;
uniform vec2 uDetailShift;    // текущий снос ветром, км
uniform float uBoil;          // подъём турбулентности при развитии, км
uniform vec3 uBoxMin, uBoxMax, uSunDir, uSunColor, uAmbTop, uAmbBottom, uHazeColor;
uniform float uExt, uDensMul, uStepNear, uStepGrow, uLightStep, uHazeBeta, uExposure;
uniform int uMaxSteps;
uniform float uLite;          // 1 — облегчённое освещение (телефоны, качество «низкое»)
uniform sampler2D uDepth;     // глубина непрозрачной сцены (рельеф, здания, земля)
uniform vec2 uRes;            // размер буфера кадра, пикс
uniform float uNear, uFar;
uniform vec3 uCamFwd;
varying vec3 vWorld;
${common}
${volume}

float D(vec3 p) { return volD(p); }
vec2 D2(vec3 p) { return volRG(p); }
// плотность с эрозией краёв детализирующим шумом (Schneider): клубы при bill=1, волокна при bill=0
float erodeD(vec2 v, vec3 p, float t, float fade) {
  vec3 dp = (p - vec3(uDetailShift.x, uBoil * v.y, uDetailShift.y)) / uDetailScale;
  // завихрение координат низкочастотным шумом: турбулентные, а не "пузырчатые" края; сильнее у волокон
  vec2 cn = textureLod(uDetail, dp * .21 + .13, 0.).rg - .5;
  dp += vec3(cn.x, cn.y, cn.x - cn.y) * mix(1.1, .45, v.y);
  vec2 n1 = textureLod(uDetail, dp, 0.).rg;
  float e = mix(n1.g, 1. - n1.r, v.y);
  float near = uLite > .5 ? 0. : 1. - smoothstep(2., 9., t);
  if (near > 0.) {
    vec2 n2 = textureLod(uDetail, dp * 3.7 + .37, 0.).rg;
    e = mix(e, e * .6 + mix(n2.g, 1. - n2.r, v.y) * .4, near);
  }
  float m = fade * e * .6;
  return clamp((v.x - m) / max(1. - m, .05), 0., 1.);
}
// фазовая функция: узкий пик вперёд (серебристая кайма), основной лобус и обратное рассеяние
float phase(float c, float s) { return .2 * hg(c, .88 * s) + .55 * hg(c, .45 * s) + .25 * hg(c, -.3 * s); }

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec2 th = boxHit(ro, rd, uBoxMin, uBoxMax);
  float t0 = max(th.x, 0.), t1 = th.y;
  // расстояние до непрозрачной поверхности по буферу глубины: облако за горой не рисуется
  float zn = texture(uDepth, gl_FragCoord.xy / uRes).r * 2. - 1.;
  float viewZ = 2. * uNear * uFar / ((uFar - uNear) * zn - (uFar + uNear));
  t1 = min(t1, -viewZ / max(dot(rd, uCamFwd), 1e-4));
  if (t1 <= t0) discard;

  float cosT = dot(rd, uSunDir);
  float awayFromSun = clamp(.5 - .5 * cosT, 0., 1.);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  float t = t0 + uStepNear * jit;
  float T = 1.;
  vec3 L = vec3(0.);
  float dAcc = 0., wAcc = 0.;
  bool empty = false;

  for (int i = 0; i < 2048; i++) {
    if (i >= uMaxSteps || t > t1 || T < .005) break;
    float dt = uStepNear * (1. + t * uStepGrow);          // шаг растёт с расстоянием (LOD)
    vec3 p = ro + rd * t;
    vec2 v = D2(p);
    float d = v.x;
    if (d < .004) { t += dt * 1.6; empty = true; continue; }   // пропуск пустоты
    if (empty) { empty = false; t -= dt * .8; continue; }       // вошли в облако — шаг назад, без проскока

    // эрозия краёв: клубы сверху у кучевых, волокна снизу, у наковальни и перистых
    float fade = uErode * mix(1., .35, smoothstep(6., 40., t));
    if (fade > 0.) {
      d = erodeD(v, p, t, fade);
      if (d < .004) { t += dt; continue; }
    }
    d *= uDensMul;
    float sigma = d * uExt;

    // оптическая толща до солнца
    float ld = 0., ls = uLightStep;
    vec3 lp = p;
    int nl = uLite > .5 ? 4 : 6;
    if (uLite > .5) ls *= 1.6;                            // меньше выборок — те же ~2 км до солнца
    for (int j = 0; j < 6; j++) {
      if (j >= nl) break;
      lp += uSunDir * ls * .5;
      // ближние выборки — с эрозией: мелкие клубы отбрасывают тени друг на друга
      ld += (j < 3 && fade > 0. ? erodeD(D2(lp), lp, t, fade) : D(lp)) * ls;
      lp += uSunDir * ls * .5; ls *= 1.9;
    }
    ld *= uDensMul * uExt;

    // приближение многократного рассеяния (октавы Вренннинге)
    vec3 sun = vec3(0.);
    float a = 1., b = 1., c = 1.;
    for (int k = 0; k < 3; k++) {
      sun += a * exp(-ld * b) * phase(cosT, c);
      a *= .45; b *= .5; c *= .5;
    }
    // powder: края с малой плотностью рассеивают меньше — тёмные впадины между клубами
    float powder = 1. - exp(-sigma * .25);
    sun *= mix(1., powder, .8 * awayFromSun);
    // окружающий свет неба, затенённый облаком сверху
    float up = D(p + vec3(0., .2, 0.)) + 2. * D(p + vec3(0., .6, 0.));
    float ao = exp(-up * uDensMul * uExt * .08);
    // боковая затенённость: впадины между клубами и между "мешками" mammatus видят меньше неба у горизонта
    float open = 1.;
    if (uLite < .5) {
      float lat = D(p + vec3(.25, -.05, 0.)) + D(p + vec3(-.25, -.05, 0.)) + D(p + vec3(0., -.05, .25)) + D(p + vec3(0., -.05, -.25));
      open = exp(-lat * .25 * uDensMul * uExt * .04);
    }
    vec3 S = uSunColor * sun + mix(uAmbBottom, uAmbTop, ao) * mix(.6, 1., powder) * mix(.35, 1., open);

    float Ts = exp(-sigma * dt);
    float w = T * (1. - Ts);
    L += S * w;
    dAcc += w * t; wAcc += w;
    T *= Ts;
    t += dt;
  }

  float alpha = 1. - T;
  if (alpha < .002) discard;
  float dist = wAcc > 0. ? dAcc / wAcc : t0;
  float fog = exp(-hazeTau(ro, rd, dist, uHazeBeta));     // метеовидимость (Кошмидер)
  vec3 hc = uHazeColor + uSunColor * .025 * hg(cosT, .7);  // дымка ярче в сторону солнца
  vec3 col = L * fog + hc * (1. - fog) * alpha;
  gl_FragColor = vec4(toDisplay(col / alpha, uExposure) * alpha, alpha);
}
`;

export const skyFrag = /* glsl */`
precision highp float;
uniform vec3 uSunDir, uSunColor, uHazeColor;
uniform float uHazeBeta, uExposure, uBetaM, uSkySunI;
varying vec3 vWorld;
${common}
${atmosphere}
void main() {
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 c = skyRadiance(cameraPosition.y, rd, uSunDir, uBetaM) * uSkySunI;
  c += uSunColor * smoothstep(.99985, .99995, dot(rd, uSunDir)) * 30.;   // солнечный диск
  // плотный туман (видимость < ~10 км) поверх модели атмосферы
  float hz = 1. - exp(-hazeTau(cameraPosition, rd, 300., uHazeBeta));
  c = mix(c, uHazeColor, hz * smoothstep(.15, .6, uHazeBeta));
  gl_FragColor = vec4(toDisplay(c, uExposure), 1.);
}
`;

// Освещение непрозрачной поверхности (рельеф, здания): солнце с тенью от облаков, свет неба
// с затенением при сплошной облачности, отражённый от земли свет и дымка по расстоянию
const surface = /* glsl */`
vec3 litSurface(vec3 p, vec3 n, vec3 alb, float spec) {
  float tau = 0.;
  vec2 th = boxHit(p, uSunDir, uBoxMin, uBoxMax);
  float a = max(th.x, 0.);
  if (th.y > a && uSunDir.y > 0.) {
    float dt = (th.y - a) / 20.;
    for (int i = 0; i < 20; i++) tau += volD(p + uSunDir * (a + (float(i) + .5) * dt)) * dt;
  }
  float sh = exp(-tau * uDensMul * uExt * .6);
  float col = 0.;
  if (all(lessThan(abs(p.xz), uBoxMax.xz))) {
    float h = uBoxMax.y - uBoxMin.y;
    for (int i = 0; i < 10; i++) col += volD(vec3(p.x, uBoxMin.y + (float(i) + .5) / 10. * h, p.z));
    col *= h / 10.;
  }
  float amb = mix(.3, 1., exp(-col * uDensMul * uExt * .05));
  vec3 vd = normalize(p - cameraPosition);
  float ndl = max(dot(n, uSunDir), 0.);
  vec3 c = alb * (uSunColor * ndl * sh + uAmbTop * amb * (.55 + .45 * n.y) + uAmbBottom * (.5 - .5 * n.y));
  if (spec > 0.) {                                        // вода: блик солнца и отражение неба
    vec3 hv = normalize(uSunDir - vd);
    c += uSunColor * sh * spec * pow(max(dot(n, hv), 0.), 180.) * 4.;
    c += uAmbTop * spec * .35 * pow(1. - max(dot(n, -vd), 0.), 4.);
  }
  float d = length(p - cameraPosition);
  float fog = exp(-hazeTau(cameraPosition, vd, d, uHazeBeta));
  vec3 hc = uHazeColor + uSunColor * .025 * hg(dot(vd, uSunDir), .7);
  return mix(hc, c, fog);
}
`;

const surfaceVert = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;      // атрибут color объявляет three.js при vertexColors (USE_COLOR)
void main() {
  vec4 w = modelMatrix * vec4(position, 1.);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
#ifdef USE_COLOR
  vColor = color;
#else
  vColor = vec3(1.);
#endif
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
export { surfaceVert };

const surfaceHead = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform vec3 uBoxMin, uBoxMax, uSunDir, uSunColor, uAmbTop, uAmbBottom, uHazeColor;
uniform float uExt, uDensMul, uHazeBeta, uExposure;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
${common}
${volume}
${surface}
`;

// Рельеф: снимок как альбедо (sRGB → линейный), море — вода с бликом
export const terrainFrag = /* glsl */`
${surfaceHead}
uniform sampler2D uImage;
uniform float uWater;         // уровень водной глади, км (−1 — воды нет)
void main() {
  vec3 alb = pow(texture(uImage, vUv).rgb, vec3(2.2)) * 1.15;
  vec3 n = normalize(vNormal);
  float water = uWater < 0. ? 0. : (1. - smoothstep(uWater + .0003, uWater + .002, vWorld.y)) * smoothstep(.97, .995, n.y);
  alb = mix(alb, alb * .6, water);
  gl_FragColor = vec4(toDisplay(litSurface(vWorld, n, alb, water), uExposure), 1.);
}
`;

// Здания: цвет вершин; лёгкая полосатость этажей на стенах вблизи
export const buildingFrag = /* glsl */`
${surfaceHead}
void main() {
  vec3 n = normalize(vNormal);
  vec3 alb = vColor;
  if (abs(n.y) < .5) {
    float floors = fract(vWorld.y / .0032);
    float near = 1. - smoothstep(1.5, 6., length(vWorld - cameraPosition));
    alb *= 1. - .25 * near * smoothstep(.55, .75, floors) * (1. - smoothstep(.85, .95, floors));
  }
  gl_FragColor = vec4(toDisplay(litSurface(vWorld, n, alb, 0.), uExposure), 1.);
}
`;

// ---------------------------------------------------------------------------
// Кинорежим (глубина резкости). 1) Глубина облаков: облегчённый проход в половинном разрешении —
// расстояние вдоль луча до места, где облако становится непрозрачным наполовину; хранится как 1/(1+t),
// 0 — облака нет. 2) Объектив: тонкая линза, разброс по кругу нерезкости, зерно ISO, виньетка, кадр 16:9.
// ---------------------------------------------------------------------------
export const cloudDepthFrag = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform vec3 uBoxMin, uBoxMax;
uniform float uExt, uDensMul;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uNear, uFar;
uniform vec3 uCamFwd;
varying vec3 vWorld;
${common}
${volume}
void main() {
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec2 th = boxHit(ro, rd, uBoxMin, uBoxMax);
  float t0 = max(th.x, 0.), t1 = th.y;
  float zn = texture(uDepth, gl_FragCoord.xy / uRes).r * 2. - 1.;
  float viewZ = 2. * uNear * uFar / ((uFar - uNear) * zn - (uFar + uNear));
  t1 = min(t1, -viewZ / max(dot(rd, uCamFwd), 1e-4));
  float tau = 0., t = t0;
  for (int i = 0; i < 160; i++) {
    if (t > t1) break;
    float dt = .08 * (1. + t * .05);
    tau += volD(ro + rd * t) * uDensMul * uExt * dt;
    if (tau > .7) { gl_FragColor = vec4(1. / (1. + t)); return; }   // облако непрозрачно наполовину
    t += dt;
  }
  gl_FragColor = vec4(0.);
}
`;

export const dofFrag = /* glsl */`
precision highp float;
uniform sampler2D uColor;        // кадр: сцена + облака
uniform sampler2D uDepth;        // глубина непрозрачной сцены
uniform sampler2D uCloudDepth;   // глубина облаков (1/(1+t))
uniform vec2 uRes;               // размер буфера, пикс
uniform float uNear, uFar;
uniform vec2 uTanHalf;           // tg половинных углов обзора камеры (x, y)
uniform vec4 uFrame;             // кадр 16:9 в uv: (x0, y0, x1, y1), вне — шторки
uniform vec2 uFocusUV;           // точка фокусировки (uv экрана)
uniform float uFocal, uN, uSensorW, uISO, uTime;
uniform float uBoost;            // усиление глубины резкости: 1 — физически точно
varying vec2 vUv;

float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// расстояние вдоль оптической оси, км: ближайшее из непрозрачной сцены и облаков
float axialZ(vec2 uv) {
  float zn = texture(uDepth, uv).r * 2. - 1.;
  float zo = -2. * uNear * uFar / ((uFar - uNear) * zn - (uFar + uNear));
  float c = texture(uCloudDepth, uv).r;
  if (c > 0.) {
    vec3 rv = vec3((uv * 2. - 1.) * uTanHalf, -1.);
    zo = min(zo, (1. / c - 1.) / length(rv));          // расстояние вдоль луча → вдоль оси
  }
  return zo;
}

void main() {
  if (any(lessThan(vUv, uFrame.xy)) || any(greaterThan(vUv, uFrame.zw))) { gl_FragColor = vec4(0., 0., 0., 1.); return; }
  // круг нерезкости по тонкой линзе: c = A·f·|z − S| / (z·(S − f)), A = f/N; всё в мм, затем в пиксели кадра
  float f = uFocal;
  float S = max(axialZ(uFocusUV) * 1e6, f * 1.5);
  float framePx = uRes.x * (uFrame.z - uFrame.x);
  float kPx = framePx / uSensorW * .5 * uBoost;         // радиус круга в пикселях на 1 мм диаметра
  float zC = axialZ(vUv) * 1e6;
  float cocC = min((f / uN) * f * abs(zC - S) / (zC * (S - f)) * kPx, 26.);
  // сбор по золотой спирали: соседняя точка размывает центр, если её круг его накрывает;
  // фон не заливает резкий передний план (берётся только при широком круге самого центра)
  const int NS = 48;
  vec3 acc = texture(uColor, vUv).rgb; float wsum = 1.;
  float R = 26.;
  for (int i = 1; i < NS; i++) {
    float r = sqrt(float(i) / float(NS)) * R;
    float a = float(i) * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * r;
    vec2 uv = vUv + o / uRes;
    float zs = axialZ(uv) * 1e6;
    float cocS = min((f / uN) * f * abs(zs - S) / (zs * (S - f)) * kPx, 26.);
    float w = smoothstep(r - 1.5, r, cocS);
    if (zs > zC) w = min(w, smoothstep(r - 1.5, r, cocC));
    acc += texture(uColor, uv).rgb * w; wsum += w;
  }
  vec3 col = acc / wsum;
  // зерно сенсора: сильнее с ISO и в тенях; виньетка объектива
  float lum = dot(col, vec3(.299, .587, .114));
  float amp = .011 * sqrt(uISO / 100.);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 917.) - .5) * amp * (1.4 - lum);
  vec2 fq = (vUv - (uFrame.xy + uFrame.zw) * .5) / (uFrame.zw - uFrame.xy);
  col *= 1. - .32 * dot(fq, fq) * 1.6;
  gl_FragColor = vec4(col, 1.);
}
`;

// Копия кадра непрозрачной сцены на экран (облака затем дорисовываются поверх)
export const blitFrag = /* glsl */`
precision highp float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture(uTex, vUv); }
`;

export const groundFrag = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform vec3 uBoxMin, uBoxMax, uSunDir, uSunColor, uAmbTop, uHazeColor;
uniform float uExt, uDensMul, uHazeBeta, uExposure;
uniform vec4 uHole;          // (xmin, zmin, xmax, zmax) квадрата рельефа, км
varying vec3 vWorld;
${noise}
${common}
${volume}
float D(vec3 p) { return volD(p); }
void main() {
  vec3 p = vWorld;
  if (all(greaterThan(p.xz, uHole.xy)) && all(lessThan(p.xz, uHole.zw))) discard;   // здесь лежит загруженный рельеф
  // ландшафт: вытянутые поля (~0.4×0.8 км), поделённые на полосы разных культур, рядки посевов,
  // дороги и лесополосы по межам, массивы леса с кронами. Каждая мелкая деталь гаснет, когда становится
  // меньше пикселя (fwidth) — вблизи есть текстура, вдали нет ряби.
  vec2 q = p.xz;                                                        // км
  vec2 g = mat2(.96, -.28, .28, .96) * q * vec2(2.6, 1.3) + vec2(vnoise2(q * .7), vnoise2(q * .7 + 9.)) * .5;
  vec2 gc = floor(g), gf = fract(g);
  float ns = 1. + floor(hash12(gc + 3.3) * 3.);                         // поле делится на 1–3 полосы
  float sx = fract(gf.x * ns);
  float ph = hash12(gc * 1.3 + floor(gf.x * ns) * 7.1);
  vec3 field = ph < .25 ? vec3(.10, .16, .05) : ph < .5 ? vec3(.30, .27, .12) : ph < .7 ? vec3(.17, .21, .08) : ph < .88 ? vec3(.21, .15, .09) : vec3(.26, .29, .14);
  field *= .9 + .2 * fbm2(q * 9. + ph * 50., 3);
  float pt = fbm2(q * 28. + ph * 13., 4);                               // пятна 20–100 м: влажность, проплешины, выгоревшая трава
  field *= .75 + .5 * pt;
  field = mix(field, vec3(.24, .22, .11), smoothstep(.55, .75, fbm2(q * 45. + 7.3, 3)) * .5);
  // рядки посевов (~10 м) вдоль длинной стороны, кроме лугов и пара
  float rw = gf.x * 38.;
  float rowsOn = (ph > .25 && ph < .88) ? 1. - smoothstep(.25, .6, fwidth(rw)) : 0.;
  field *= mix(1., .8 + .4 * (.5 + .5 * sin(rw * 6.2831853)), rowsOn);
  // мелкая текстура: ~15 м и ~2 м
  vec2 m1 = q * 70., m2 = q * 500.;
  field *= mix(1., .75 + .5 * fbm2(m1 + ph * 30., 3), 1. - smoothstep(.6, 2.5, min(abs(dFdx(m1.x)) + abs(dFdx(m1.y)), abs(dFdy(m1.x)) + abs(dFdy(m1.y)))));
  field *= mix(1., .7 + .6 * vnoise2(m2), 1. - smoothstep(.6, 2.5, min(abs(dFdx(m2.x)) + abs(dFdx(m2.y)), abs(dFdy(m2.x)) + abs(dFdy(m2.y)))));
  vec2 m3 = q * 3000.;                                                   // ~0.3 м: трава у самой камеры
  field *= mix(1., .75 + .5 * vnoise2(m3), 1. - smoothstep(.6, 2.5, min(abs(dFdx(m3.x)) + abs(dFdx(m3.y)), abs(dFdy(m3.x)) + abs(dFdy(m3.y)))));
  // межи: по краям поля — дорога, лесополоса или просто граница; между полосами — тонкая линия
  float edgeKm = min(min(gf.x, 1. - gf.x) * .385, min(gf.y, 1. - gf.y) * .77);
  float aaE = fwidth(edgeKm) * 1.5 + 1e-5;
  float et = hash12(gc + 17.7);
  float wE = et > .65 ? .005 : et > .35 ? .009 : .0025;
  vec3 eCol = et > .65 ? vec3(.30, .29, .26) : et > .35 ? vec3(.045, .07, .035) : field * .7;
  vec3 alb = mix(eCol, field, smoothstep(wE - aaE, wE + aaE, edgeKm));
  float sKm = min(sx, 1. - sx) * .385 / ns;
  float aaS = fwidth(sKm) * 1.5 + 1e-5;
  alb *= mix(.8, 1., smoothstep(.0015 - aaS, .0015 + aaS, sKm));
  alb = mix(alb, vec3(.18, .20, .09), smoothstep(.15, .9, length(fwidth(g))));   // вдали — средний цвет
  // лес с кронами (~8 м)
  float forest = smoothstep(.52, .6, fbm2(q * .28 + 3.7, 5));
  if (forest > 0.) {
    vec2 cr = q * 120.;
    float crf = 1. - smoothstep(.3, 1., length(fwidth(cr)));
    float crowns = crf > 0. ? mix(1., .55 + .8 * (1. - worley3(vec3(cr, .5))), crf) : 1.;
    vec3 fcol = vec3(.045, .075, .035) * (.8 + .4 * fbm2(q * 6., 3)) * crowns;
    alb = mix(alb, fcol, forest);
  }

  // тень от облаков: оптическая толща вдоль луча на солнце
  float tau = 0.;
  vec2 th = boxHit(p, uSunDir, uBoxMin, uBoxMax);
  float a = max(th.x, 0.);
  if (th.y > a && uSunDir.y > 0.) {
    float dt = (th.y - a) / 24.;
    for (int i = 0; i < 24; i++) tau += D(p + uSunDir * (a + (float(i) + .5) * dt)) * dt;
  }
  float sh = exp(-tau * uDensMul * uExt * .6);
  // затемнение рассеянного света при сплошной облачности
  float col = 0.;
  if (abs(p.x) < uBoxMax.x && abs(p.z) < uBoxMax.z) {
    float h = uBoxMax.y - uBoxMin.y;
    for (int i = 0; i < 12; i++) col += D(vec3(p.x, uBoxMin.y + (float(i) + .5) / 12. * h, p.z));
    col *= h / 12.;
  }
  float amb = mix(.3, 1., exp(-col * uDensMul * uExt * .05));
  vec3 lit = alb * (uSunColor * max(uSunDir.y, 0.) * sh + uAmbTop * amb);
  vec3 dv = vWorld - cameraPosition;
  vec3 vd = normalize(dv);
  float fog = exp(-hazeTau(cameraPosition, vd, length(dv), uHazeBeta));
  vec3 hc = uHazeColor + uSunColor * .025 * hg(dot(vd, uSunDir), .7);
  gl_FragColor = vec4(toDisplay(mix(hc, lit, fog), uExposure), 1.);
}
`;

// ---------------------------------------------------------------------------
// Метеорадар: отражаемость ~ интеграл d^2 по вертикали, полярные бины, палитра NWS.
// ---------------------------------------------------------------------------
export const radarFrag = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform vec3 uBoxMin, uBoxMax;
uniform vec4 uView;      // область миникарты: (xmin, zmin, сторона), км
varying vec2 vUv;
${volume}

vec3 dbzColor(float z) {
  if (z < 10.) return vec3(.016, .914, .906);
  if (z < 15.) return vec3(.004, .624, .957);
  if (z < 20.) return vec3(.012, .0, .957);
  if (z < 25.) return vec3(.008, .992, .008);
  if (z < 30.) return vec3(.004, .773, .004);
  if (z < 35.) return vec3(.0, .557, .0);
  if (z < 40.) return vec3(.992, .973, .008);
  if (z < 45.) return vec3(.898, .737, .0);
  if (z < 50.) return vec3(.992, .584, .0);
  if (z < 55.) return vec3(.992, .0, .0);
  if (z < 60.) return vec3(.831, .0, .0);
  if (z < 65.) return vec3(.737, .0, .0);
  return vec3(.973, .0, .992);
}

void main() {
  vec2 uv = vec2(vUv.x, 1. - vUv.y);          // верх миникарты — север (-z)
  vec2 dd = uv - .5;
  float a = atan(dd.y, dd.x), r = length(dd);
  float da = 6.2831853 / 360., dr = 1. / 200.;
  a = (floor(a / da) + .5) * da;
  r = (floor(r / dr) + .5) * dr;
  vec2 b = .5 + r * vec2(cos(a), sin(a));
  vec3 bg = vec3(.02, .05, .04);
  vec2 xz = uView.xy + b * uView.z;
  if (any(lessThan(xz, uBoxMin.xz)) || any(greaterThan(xz, uBoxMax.xz))) { gl_FragColor = vec4(bg * .5, 1.); return; }
  float acc = 0.;
  float span = uBoxMax.y - uBoxMin.y;
  for (int k = 0; k < 96; k++) { float v = volD(vec3(xz.x, uBoxMin.y + (float(k) + .5) / 96. * span, xz.y)); acc += v * v; }
  float lwp = acc * span / 96.;
  float dbz = 10. + 35. * log(max(lwp, 1e-6) / .6) / log(10.);
  vec3 col = dbz >= 5. ? dbzColor(dbz) : bg;
  gl_FragColor = vec4(col, 1.);
}
`;

// Копия одного среза зоны из атласа (для экспорта density volume зоны в файл)
export const copySliceFrag = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uSrc;
uniform vec4 uRegion;    // (u0, v0, du, dv) — область зоны в атласе
uniform float uR;        // координата среза
varying vec2 vUv;
void main() { gl_FragColor = vec4(textureLod(uSrc, vec3(uRegion.xy + vUv * uRegion.zw, uR), 0.).r, 0., 0., 1.); }
`;
