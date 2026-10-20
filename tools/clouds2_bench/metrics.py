# Метрики похожести рендера облаков на реальные фото (#78, E0).
#
# Облака на рендере и на фото — разные облака, поэтому попиксельные метрики
# (SSIM, PSNR) бессмысленны: считаются статистические и перцептивные метрики
# по маске облаков (раздел «Метрики похожести» вики «Методика тестирования»):
#
#   M1 — EMD (Вассерштейн) между гистограммами L* (CIELAB) масок облаков
#        кадра и эталонного реального фото того же типа;
#   M2 — контраст светотени: отношение перцентилей L* 95/5 внутри маски;
#   M3 — детали на всех масштабах: наклон радиального спектра мощности L*
#        (лог-лог, полоса 4–256 px; чем отрицательнее — тем мельче детали);
#   M4 — изрезанность границы: фрактальная размерность границы маски
#        (бокс-каунтинг; у реальных Cu ≈ 1.3–1.4);
#   M5 — резкость края: модуль градиента L* на границе маски (медиана, p90);
#   M7 — цвет: средние и разброс a*, b* в маске облаков и в небе.
#
# M6 (перцептивная близость DINOv2/CLIP) — отдельный опциональный шаг:
# требует Python+torch, эмбеддинги кэшируются; в этом модуле не считается.
#
# Все изображения приводятся к единой ширине WIDTH px, чтобы полосы спектра
# и боксы бокс-каунтинга означали одно и то же на фото и на рендере.
# Коридоры реальности (перцентили 10–90 по 30 фото типа) считаются в
# realset/corridors.py по скачанным фото Wikimedia (реестр лицензий —
# realset/manifest.json).
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.stats import wasserstein_distance

# ширина нормализации: полоса спектра 4–256 px и боксы 2–64 px осмысленны
# только на фиксированном масштабе
WIDTH = 1024
# параметры маски облаков по умолчанию (дневные фото); для сцен с закатом и
# видом сверху в scenes.json задаётся своя настройка (mode/пороги)
MASK_DEFAULT = {
    'mode': 'hsv',       # 'hsv' — по цвету; 'bright' — ярче локального фона
    's_cloud': 0.30,     # выше этой насыщенности белого облака уже нет
    'v_min': 0.30,       # ниже этой яркости — тени/земля, не облако
    'sky_h': (190, 270), 'sky_s': 0.12, 'sky_v': 0.0,  # синее небо
    'ground_h': (55, 175), 'ground_s': 0.22,  # зелёная земля
    'sun_v': 0.97, 'sun_s': 0.30, 'sun_h': (15, 65),  # диск/гало солнца
    'dv_sigma': 100,     # для mode='bright': радиус локального фона (px)
    'dv_thr': 0.015,     # насколько ярче локального фона — уже облако
    'band': None,        # (y0, y1) доля кадра — зона, где вообще ищем облака
}


def load_image(path: str | Path, width: int = WIDTH) -> np.ndarray:
    """PNG/WebP → RGB float [0,1], нормированный по ширине."""
    im = Image.open(path).convert('RGB')
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    return np.asarray(im, dtype=np.float64) / 255.0


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def rgb_to_lab(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """RGB [0,1] → (L*, a*, b*), D65."""
    lin = srgb_to_linear(rgb)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    e, k = 216 / 24389, 24389 / 27
    f = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return L, a, b


def cloud_mask(rgb: np.ndarray, cfg: dict | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Маска облаков и маска неба (HSV-пороги + морфология).

    Облака — малонасыщенные (на закате золотистые, но всё ещё слабее неба
    и земли); небо — синее/голубое, земля — зелёная, диск солнца — почти
    пересвечен. Возвращает (cloud, sky).
    """
    p = {**MASK_DEFAULT, **(cfg or {})}
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    v = mx
    s = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.maximum(mx - mn, 1e-9)
    h = np.zeros_like(mx)
    m = mx == r
    h[m] = ((g - b)[m] / d[m]) % 6
    m = (mx == g) & (mx != r)
    h[m] = ((b - r)[m] / d[m]) + 2
    m = (mx == b) & (mx != r) & (mx != g)
    h[m] = ((r - g)[m] / d[m]) + 4
    h *= 60

    # лёгкое сглаживание: в снимках стенда есть дизеринг-зерно, порог по
    # сырым s/v даёт соли́нку и ступенчатые края маски
    s = ndimage.gaussian_filter(s, 2.0)
    v = ndimage.gaussian_filter(v, 2.0)

    sky = ((h >= p['sky_h'][0]) & (h <= p['sky_h'][1])
           & (s >= p['sky_s']) & (v >= p['sky_v']))
    ground = (h >= p['ground_h'][0]) & (h <= p['ground_h'][1]) & (s >= p['ground_s'])
    sun = (v >= p['sun_v']) & (s >= p['sun_s']) & (h >= p['sun_h'][0]) & (h <= p['sun_h'][1])

    if p['mode'] == 'bright':
        # ярче локального фона: цирры и кучевые светлее surrounding-неба даже
        # на закате, где цвет неба и облаков неразличимы (cool_2)
        dv = v - ndimage.gaussian_filter(v, p['dv_sigma'])
        cloud = (dv > p['dv_thr']) & ~ground & ~sun
    else:
        cloud = (s <= p['s_cloud']) & (v >= p['v_min']) & ~sky & ~ground & ~sun
    if p['band'] is not None:
        y0 = int(cloud.shape[0] * p['band'][0])
        y1 = int(cloud.shape[0] * p['band'][1])
        keep = np.zeros_like(cloud)
        keep[y0:y1] = True
        cloud &= keep
        sky &= keep
    # морфология: открытие убирает крапинки, закрытие — дырки в облаке
    cloud = ndimage.binary_closing(ndimage.binary_opening(cloud, np.ones((3, 3))),
                                   np.ones((7, 7)))
    lab, n = ndimage.label(cloud)
    if n > 1:  # оставляем связные компоненты ≥0.05% кадра
        sizes = np.bincount(lab.ravel())
        cloud = np.isin(lab, np.nonzero(sizes >= cloud.size * 5e-5)[0])
        cloud &= lab > 0
    return cloud, sky


# ---------------------------------------------------------------- M1, M2
def lstar_hist(L: np.ndarray, mask: np.ndarray, bins: int = 50) -> np.ndarray:
    """Нормированная гистограмма L* по маске (для EMD)."""
    h, _ = np.histogram(L[mask], bins=bins, range=(0, 100))
    return h / max(h.sum(), 1)


def m1_emd(L_a: np.ndarray, mask_a: np.ndarray, L_b: np.ndarray, mask_b: np.ndarray) -> float:
    """EMD между гистограммами L* масок (0–100, меньше — ближе распределения)."""
    centers = np.arange(50) * 2 + 1
    return float(wasserstein_distance(centers, centers,
                                      lstar_hist(L_a, mask_a), lstar_hist(L_b, mask_b)))


def m2_contrast(L: np.ndarray, mask: np.ndarray) -> float:
    """Контраст светотени: L* p95 / p5 внутри маски."""
    inside = L[mask]
    p5, p95 = np.percentile(inside, [5, 95])
    return float(p95 / max(p5, 1.0))


# ---------------------------------------------------------------- M3
def m3_spectrum_slope(L: np.ndarray, mask: np.ndarray,
                      kmin_px: int = 4, kmax_px: int = 256) -> float:
    """Наклон радиального спектра мощности L* (лог-лог) в полосе 4–256 px.

    За маской L* заменяется средним по маске (иначе кромка маски даёт
    искусственный белый шум спектра), затем окно Ханнинга, FFT, радиальное
    усреднение |F|² и линейная регрессия log P ~ log k. Наклон отрицательный.
    """
    fill = L[mask].mean() if mask.any() else L.mean()
    img = np.where(mask, L, fill)
    img = img - img.mean()
    win = np.hanning(img.shape[0])[:, None] * np.hanning(img.shape[1])[None, :]
    spec = np.abs(np.fft.fftshift(np.fft.fft2(img * win))) ** 2
    cy, cx = np.array(img.shape) // 2
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    rad = np.hypot(yy - cy, xx - cx)
    # частоты в циклах/пиксель; полоса [1/kmax_px, 1/kmin_px]
    lo, hi = 1.0 / kmax_px, 1.0 / kmin_px
    nb = 32
    edges = np.geomspace(lo, hi, nb + 1)
    ks, ps = [], []
    for i in range(nb):
        sel = (rad >= edges[i] * cy * 2) & (rad < edges[i + 1] * cy * 2)
        if sel.sum() >= 8:
            ks.append(math.sqrt(edges[i] * edges[i + 1]))
            ps.append(spec[sel].mean())
    if len(ks) < 6:
        return float('nan')
    return float(np.polyfit(np.log(ks), np.log(ps), 1)[0])


# ---------------------------------------------------------------- M4
def box_count_dim(pixel_mask: np.ndarray, smin: int = 2, smax: int = 64,
                  sizes: list[int] | None = None, offsets: int = 4) -> float:
    """Фрактальная размерность множества True-пикселей (бокс-каунтинг).

    log N(s) ~ -D·log s; масштабы — геометрическая прогрессия, счёт
    усредняется по offsets смещениям сетки (иначе фаза сетки смещает наклон).
    Для точных самоподобных фрактал масштабы можно задать явно по ступеням
    самоподобности, а сетку выровнять (offsets=1) — тогда счёт даёт точное
    значение (ковёр Серпинского по ступеням 3); произвольные масштабы и
    смещённые сетки дают расхождение в несколько %.
    """
    ys, xs = np.nonzero(pixel_mask)
    n = min(pixel_mask.shape)
    if len(ys) < 100:
        return float('nan')
    explicit = sizes is not None
    if sizes is None:
        smax = min(smax, n // 8)
        if smax <= smin:
            return float('nan')
        sizes = np.unique(np.round(np.geomspace(smin, smax, 12)).astype(int))
        sizes = [int(s) for s in sizes if s >= 1]
    counts: list[float] = []
    used: list[int] = []
    span = int(xs.max()) + 2
    for s in sizes:
        vals = []
        for o in range(offsets):
            gy = (ys + o * s // 4) // s
            gx = (xs + o * s // 4) // s
            vals.append(len(np.unique(gy * (span // s + 3) + gx)))
        c = float(np.mean(vals))
        if c > 1:
            used.append(int(s))
            counts.append(c)
    if len(used) < (3 if explicit else 6):
        return float('nan')
    return float(-np.polyfit(np.log(used), np.log(counts), 1)[0])


def m4_fractal_dim(mask: np.ndarray, smin: int = 2, smax: int = 64) -> float:
    """Фрактальная размерность границы облака: бокс-каунтинг кромки маски."""
    edge = mask ^ ndimage.binary_erosion(mask, np.ones((3, 3)))
    return box_count_dim(edge, smin, smax)


# ---------------------------------------------------------------- M5
def m5_edge_sharpness(L: np.ndarray, mask: np.ndarray) -> dict:
    """|∇L*| на кромке маски: медиана и p90 (больше — резче край)."""
    edge = mask ^ ndimage.binary_erosion(mask, np.ones((3, 3)))
    gy, gx = np.gradient(L)
    mag = np.hypot(gx, gy)[edge]
    if mag.size == 0:
        return {'median': float('nan'), 'p90': float('nan')}
    return {'median': float(np.median(mag)), 'p90': float(np.percentile(mag, 90))}


# ---------------------------------------------------------------- M7
def m7_color(rgb: np.ndarray, mask: np.ndarray, sky: np.ndarray) -> dict:
    """a*, b* в облаках и в небе: среднее и разброс."""
    _, a, b = rgb_to_lab(rgb)
    out = {}
    for name, m in (('cloud', mask), ('sky', sky)):
        if m.sum() < 50:
            out[name] = {'a_mean': float('nan'), 'a_std': float('nan'),
                         'b_mean': float('nan'), 'b_std': float('nan')}
            continue
        out[name] = {'a_mean': float(a[m].mean()), 'a_std': float(a[m].std()),
                     'b_mean': float(b[m].mean()), 'b_std': float(b[m].std())}
    return out


def compute_metrics(path: str | Path, ref_path: str | Path | None = None,
                    mask_cfg: dict | None = None,
                    ref_mask_cfg: dict | None = None) -> dict:
    """Все метрики одного кадра (+ M1 к эталонному фото, если оно есть).

    mask_cfg — настройка маски для самого кадра, ref_mask_cfg — для
    эталонного фото (у фото другой свет; пороги подобраны визуально).
    """
    rgb = load_image(path)
    cloud, sky = cloud_mask(rgb, mask_cfg)
    L, _, _ = rgb_to_lab(rgb)
    res = {
        'file': str(path),
        'cloud_frac': float(cloud.mean()),
        'm2_contrast': m2_contrast(L, cloud),
        'm3_slope': m3_spectrum_slope(L, cloud),
        'm4_fd': m4_fractal_dim(cloud),
        'm5': m5_edge_sharpness(L, cloud),
        'm7': m7_color(rgb, cloud, sky),
    }
    if ref_path and Path(ref_path).exists():
        rgb_r = load_image(ref_path)
        cloud_r, _ = cloud_mask(rgb_r, ref_mask_cfg if ref_mask_cfg is not None else mask_cfg)
        L_r, _, _ = rgb_to_lab(rgb_r)
        res['m1_emd'] = m1_emd(L, cloud, L_r, cloud_r)
    else:
        res['m1_emd'] = None
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description='Метрики похожести кадров стенда (#78)')
    ap.add_argument('--shots', required=True, help='каталог со снимками')
    ap.add_argument('--scenes', required=True, help='scenes.json (референсы и настройки масок)')
    ap.add_argument('--out', default=None, help='куда записать metrics.json')
    args = ap.parse_args()

    shots = Path(args.shots)
    scenes = json.loads(Path(args.scenes).read_text(encoding='utf-8'))
    out = Path(args.out) if args.out else shots / 'metrics.json'
    views = list(scenes.get('views', {}))

    masks = scenes.get('mask', {})  # per-сцена настройки маски (необязательно)
    rows: list[dict] = []
    refs: dict[str, dict] = {}
    for name, sc in scenes['scenes'].items():
        ref = None
        if sc.get('ref'):
            ref = (Path(args.scenes).parent / sc['ref']).resolve()
        # настройка сцены общая для снимков; "ref" — перекрытие для эталонного
        # фото (у фото другой свет/тон, но пороги подобраны визуально под обе картинки)
        base = masks.get(name) or {}
        cfg = {k: v for k, v in base.items() if k != 'ref'} or None
        ref_cfg = {**base, **base.get('ref', {})}
        ref_cfg.pop('ref', None)
        ref_cfg = ref_cfg or None
        # сам эталонный кадр — чтобы отчёт показывал «где реальное фото»
        if ref and ref.exists():
            try:
                r = compute_metrics(ref, None, ref_cfg)
                r.pop('m1_emd', None)
                r['file'] = str(ref)
                refs[name] = r
            except Exception as e:  # noqa: BLE001
                refs[name] = {'error': str(e), 'file': str(ref)}
        for view in views:
            png = shots / f'{name}_{view}.png'
            if not png.exists():
                rows.append({'scene': name, 'view': view, 'error': 'нет снимка'})
                continue
            try:
                m = compute_metrics(png, ref, cfg, ref_cfg)
                m['scene'], m['view'] = name, view
                rows.append(m)
            except Exception as e:  # noqa: BLE001 — метрика не должна ронять стенд
                rows.append({'scene': name, 'view': view, 'file': str(png), 'error': str(e)})
    out.write_text(json.dumps({'date': __import__('datetime').datetime.now().isoformat(),
                               'width': WIDTH, 'results': rows, 'references': refs},
                              ensure_ascii=False, indent=1), encoding='utf-8')
    n_err = sum(1 for r in rows if 'error' in r)
    print(f'метрики: {len(rows)} кадров + {len(refs)} референсов, ошибок {n_err} → {out}')


if __name__ == '__main__':
    main()
