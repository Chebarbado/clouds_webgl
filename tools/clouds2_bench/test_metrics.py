# Юнит-тесты метрик на синтетике (#78): известный фрактал → известная
# размерность ±0.05, известный спектр → известный наклон ±0.1; плюс
# адверсальные проверки: размытие 4× ухудшает M3/M5, шум 1% яркости
# меняет метрики < 3%.
#   python tools/clouds2_bench/test_metrics.py
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from metrics import (box_count_dim, cloud_mask, m1_emd, m2_contrast,  # noqa: E402
                     m3_spectrum_slope, m5_edge_sharpness)

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    print(f"{'OK ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ''))
    if not ok:
        FAILS.append(name)


# ---- известный фрактал: серпинский ковёр, D = log8/log3 = 1.8928 -------
def sierpinski_carpet(n: int = 729) -> np.ndarray:
    a = np.ones((n, n), dtype=bool)
    s = n
    while s >= 3:
        s //= 3
        for y in range(0, n, s * 3):
            for x in range(0, n, s * 3):
                a[y + s:y + 2 * s, x + s:x + 2 * s] = False
    return a


carpet = sierpinski_carpet()
d_true = np.log(8) / np.log(3)
d_aligned = box_count_dim(carpet, sizes=[3, 9, 27, 81], offsets=1)
check('M4 серпинский ковёр (ступени 3) D≈log8/log3', abs(d_aligned - d_true) < 0.05,
      f'измерено {d_aligned:.3f}, эталон {d_true:.3f}')

# ---- известный фрактал на произвольных масштабах: кривая Коха, D=log4/log3 -
from PIL import Image, ImageDraw  # noqa: E402


def koch_snowflake(iterations: int = 5, side: int = 585) -> np.ndarray:
    h = side * math.sqrt(3) / 2
    pts = [(side / 2, 0.0), (0.0, h), (side, h)]
    for _ in range(iterations):
        new = []
        for i in range(len(pts)):
            a = np.array(pts[i])
            b = np.array(pts[(i + 1) % len(pts)])
            d = (b - a) / 3
            p1, p2 = a + d, a + 2 * d
            ang = -np.pi / 3
            rot = np.array([d[0] * np.cos(ang) - d[1] * np.sin(ang),
                            d[0] * np.sin(ang) + d[1] * np.cos(ang)])
            new += [tuple(p1), tuple(p1 + rot), tuple(p2), tuple(b)]
        pts = new
    im = Image.new('L', (side, side), 0)
    dr = ImageDraw.Draw(im)
    dr.line(pts + [pts[0]], fill=255, width=1)
    return np.asarray(im) > 0


d_koch = box_count_dim(koch_snowflake(), smin=2, smax=64)
d_koch_true = np.log(4) / np.log(3)
check('M4 кривая Коха (произв. масштабы) D≈log4/log3', abs(d_koch - d_koch_true) < 0.05,
      f'измерено {d_koch:.3f}, эталон {d_koch_true:.3f}')

# ---- известный спектр: fBm-поле с наклоном P ~ k^-beta ------------------
def fbm_field(n: int, beta: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal((n, n))
    F = np.fft.fftshift(np.fft.fft2(noise))
    cy = cx = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    k = np.hypot(yy - cy, xx - cx)
    k[cy, cx] = 1.0
    F *= k ** (-beta / 2)          # мощность ~ k^-beta
    img = np.real(np.fft.ifft2(np.fft.ifftshift(F)))
    return img


for beta in (2.0, 2.6, 3.2):
    f = fbm_field(512, beta, seed=42)
    L = 50 + 20 * (f - f.mean()) / f.std()   # «яркость» в условных единицах
    mask = np.ones_like(L, dtype=bool)
    slope = m3_spectrum_slope(L, mask)
    check(f'M3 спектр beta={beta}', abs(slope + beta) < 0.1,
          f'наклон {slope:.3f}, эталон {-beta:.3f}')

# ---- M1 на идентичных/очень разных распределениях ----------------------
rng = np.random.default_rng(7)
L_a = np.clip(rng.normal(70, 12, (200, 200)), 0, 100)
L_b = np.clip(rng.normal(70, 12, (200, 200)), 0, 100)
L_c = np.clip(rng.normal(35, 25, (200, 200)), 0, 100)
m = np.ones_like(L_a, dtype=bool)
emd_same = m1_emd(L_a, m, L_b, m)
emd_diff = m1_emd(L_a, m, L_c, m)
check('M1 одинаковые распределения ближе разных', emd_same < emd_diff * 0.5,
      f'emd_same={emd_same:.2f}, emd_diff={emd_diff:.2f}')

# ---- M2 контраст на синтетике: светлая «шапка» + тёмное «дно» ----------
L2 = np.full((100, 100), 20.0)
L2[:40] = 90.0
m2 = np.ones_like(L2, dtype=bool)
check('M2 контраст p95/p5', abs(m2_contrast(L2, m2) - 4.5) < 0.15,
      f'{m2_contrast(L2, m2):.2f} ≈ 4.5')

# ---- адверсально: размытие 4× резко ухудшает M3/M5 ---------------------
img = np.roll(fbm_field(256, 2.4, seed=3), 0)
Limg = 50 + 15 * (img - img.mean()) / img.std()
mask_img = np.ones_like(Limg, dtype=bool)
s_sharp = m3_spectrum_slope(Limg, mask_img)
e_sharp = m5_edge_sharpness(Limg, mask_img)
blur = np.array([[1, 4, 6, 4, 1],
                 [4, 16, 24, 16, 4],
                 [6, 24, 36, 24, 6],
                 [4, 16, 24, 16, 4],
                 [1, 4, 6, 4, 1]], dtype=float) / 256
from scipy import ndimage  # noqa: E402
Lblur = ndimage.convolve(Limg, blur, mode='reflect')
s_blur = m3_spectrum_slope(Lblur, mask_img)
e_blur = m5_edge_sharpness(Lblur, mask_img)
check('M3 размытие 4× → спектр заметно ниже', s_blur < s_sharp - 0.25,
      f'{s_sharp:.3f} → {s_blur:.3f}')
check('M5 размытие 4× → край заметно мягче', e_blur['p90'] < e_sharp['p90'] * 0.5,
      f"p90 {e_sharp['p90']:.2f} → {e_blur['p90']:.2f}")

# ---- устойчивость: шум 1% яркости меняет метрики < 3% ------------------
rngn = np.random.default_rng(11)
Lnoise = Limg + rngn.normal(0, 1.0, Limg.shape)   # 1% от диапазона L*=100
check('M3 шум 1% меняет < 3%',
      abs(m3_spectrum_slope(Lnoise, mask_img) - s_sharp) / abs(s_sharp) < 0.03,
      f'{s_sharp:.3f} → {m3_spectrum_slope(Lnoise, mask_img):.3f}')
e0, e1 = m5_edge_sharpness(Limg, mask_img), m5_edge_sharpness(Lnoise, mask_img)
check('M5 шум 1% меняет < 3%',
      abs(e1['p90'] - e0['p90']) / e0['p90'] < 0.03,
      f"{e0['p90']:.3f} → {e1['p90']:.3f}")
check('M2 шум 1% меняет < 3%',
      abs(m2_contrast(Lnoise, mask_img) - m2_contrast(Limg, mask_img))
      / m2_contrast(Limg, mask_img) < 0.03)

# ---- маска: белые «облака» на синем «небе» и зелёной «земле» ------------
h, w = 120, 200
synth = np.zeros((h, w, 3))
synth[:] = (0.25, 0.45, 0.85)                    # небо
synth[80:] = (0.25, 0.55, 0.2)                   # земля
synth[20:50, 40:90] = (0.92, 0.92, 0.93)         # облако
cm, sm = cloud_mask(synth)
check('маска: облако найдено', cm[30, 60] and cm[25, 45])
check('маска: небо — не облако', not cm[5, 5] and sm[5, 5])
check('маска: земля — не облако', not cm[100, 100])

print()
if FAILS:
    print(f'FAIL: {len(FAILS)} проверок: ' + ', '.join(FAILS))
    sys.exit(1)
print('OK: все проверки метрик пройдены')
