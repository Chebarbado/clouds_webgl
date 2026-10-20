"""Коридоры реальности для метрик (#78): перцентили 10–90 по 30 фото типа.

По вики «Методика тестирования»: коридор — диапазон метрики на 30 реальных
фото того же типа облаков; отложенный набор (holdout, не участвовавший в
калибровке) обязан попадать в коридор — это проверка самих метрик.

Считает M2, M3, M4, M5 (p50/p90), M7 (a*/b* облака) по дефолтной маске и
пишет realset/corridors.json со сводкой holdout-проверки.

Инструмент (решение после эксперимента 20.10): коридор считается по
дефолтной HSV-маске — она же у снимков ieta/cool_1 (совпадение 16/18 строк
отчёта). Кадровая маска cool_2 (v_min 0.75 + band) на реальных фото дала
33/40 отката — пороги, подобранные под конкретный рендер, для фото
непригодны; расхождение инструмента cool_2 (кадры 0.75 vs коридор 0.30)
и его ref-перекрытие (0.55) — известное ограничение, вердикт cool_2
индикативен и отмечен в отчёте/заметке. Опциональный обходной ход —
scenes.json → mask._types.{cu,ci} (по умолчанию не задан).

Запуск: python tools/clouds2_bench/corridors.py
"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from metrics import compute_metrics  # noqa: E402

SET_DIR = Path(__file__).resolve().parent / 'realset'
SCENES = ROOT / 'mvp_clouds2' / 'test' / 'scenes.json'
OUT = SET_DIR / 'corridors.json'

# 7 метрик с коридором (M1 — расстояние до конкретного фото, своего коридора
# не имеет; M6 — опциональная, отложена)
KEYS = ('m2', 'm3', 'm4', 'm5_median', 'm5_p90', 'm7a', 'm7b')


def flat(m):
    """compute_metrics → плоский словарь из семи коридорных метрик."""
    return {
        'm2': m['m2_contrast'], 'm3': m['m3_slope'], 'm4': m['m4_fd'],
        'm5_median': m['m5']['median'], 'm5_p90': m['m5']['p90'],
        'm7a': m['m7']['cloud']['a_mean'], 'm7b': m['m7']['cloud']['b_mean'],
        'cloud_frac': m['cloud_frac'],
    }


def percentiles(values):
    import numpy as np
    v = [x for x in values if x is not None and x == x]  # без NaN
    if len(v) < 5:
        return None
    p10, p50, p90 = np.percentile(v, [10, 50, 90])
    return {'p10': float(p10), 'p50': float(p50), 'p90': float(p90)}


def main():
    manifest = json.loads((SET_DIR / 'manifest.json').read_text(encoding='utf-8'))
    scenes = json.loads(SCENES.read_text(encoding='utf-8'))
    type_cfgs = (scenes.get('mask') or {}).get('_types') or {}

    out = {'date': datetime.now().isoformat(timespec='seconds'),
           'calib_n': {}, 'types': {}, 'holdout': {}}
    for ctype in sorted({p['type'] for p in manifest['photos']}):
        cfg = type_cfgs.get(ctype)
        rows = {'calib': [], 'holdout': []}
        for p in manifest['photos']:
            if p['type'] != ctype:
                continue
            path = SET_DIR / p['file']
            if not path.exists():
                print(f'нет файла {p["file"]}')
                continue
            m = compute_metrics(path, None, cfg)
            if m.get('m4_fd') != m.get('m4_fd'):  # NaN — маска не дала границу
                print(f'NaN в метриках {p["file"]} — пропуск')
                continue
            rows[p['split']].append({'file': p['file'], **flat(m)})
        calib = rows['calib']
        out['calib_n'][ctype] = len(calib)
        if len(calib) < 5:
            print(f'{ctype}: мало калибровочных фото ({len(calib)}) — коридор не построен')
            continue
        out['types'][ctype] = {k: percentiles([r[k] for r in calib]) for k in KEYS}
        for k, band in out['types'][ctype].items():
            if band:
                print(f'{ctype} {k:10s} p10..p90 = {band["p10"]:.3f}..{band["p90"]:.3f}'
                      f'  (p50 {band["p50"]:.3f})')

        # holdout: доля попаданий в коридор — проверка самих метрик
        corr = out['types'][ctype]
        in_n = total = 0
        outs = []
        for r in rows['holdout']:
            for k in KEYS:
                band = corr.get(k)
                if not band:
                    continue
                total += 1
                if band['p10'] <= r[k] <= band['p90']:
                    in_n += 1
                else:
                    outs.append({'file': r['file'], 'metric': k,
                                 'value': round(r[k], 3),
                                 'p10': round(band['p10'], 3),
                                 'p90': round(band['p90'], 3)})
        out['holdout'][ctype] = {'in': in_n, 'total': total,
                                 'frac': round(in_n / total, 3) if total else None,
                                 'out': outs}
        if total:
            print(f'{ctype} holdout: {in_n}/{total} '
                  f'({100 * in_n / total:.0f}%) значений в коридоре')
            for o in outs[:8]:
                print(f'   вне коридора: {o["file"]} {o["metric"]}={o["value"]} '
                      f'(коридор {o["p10"]}..{o["p90"]})')
            if len(outs) > 8:
                print(f'   … и ещё {len(outs) - 8}')

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'→ {OUT}')


if __name__ == '__main__':
    main()
