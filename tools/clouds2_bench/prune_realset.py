"""Пере-QC скачанного realset правилами photo_qc: откат городов/пустынь/рек.

Запуск после правил QC в fetch_realset.py: прогоняет все фото из manifest.json
через те же правила отбора (маска + «земля вместо неба»), брак удаляет с диска.
После prune_realset.py запустить fetch_realset.py (без --fresh) — он дособирает
недостающие калибровочные/holdout-фото.

Запуск: python tools/clouds2_bench/prune_realset.py
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_realset import OUT, photo_qc  # noqa: E402
from metrics import cloud_mask, load_image  # noqa: E402


def main():
    manifest_path = OUT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    keep, dropped = [], []
    for p in manifest['photos']:
        path = OUT / p['file']
        if not path.exists():
            dropped.append((p['file'], 'нет файла'))
            continue
        arr = load_image(path)
        cloud, sky = cloud_mask(arr)
        reason = photo_qc(arr, cloud, sky)
        if reason:
            dropped.append((p['file'], reason))
            continue
        p['cloud_frac'] = round(float(cloud.mean()), 3)
        keep.append(p)
    manifest['photos'] = keep
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    for f, why in dropped:
        (OUT / f).unlink(missing_ok=True)
        print(f'− {f}: {why}')
    n = Counter(p['type'] for p in keep)
    s = Counter((p['type'], p['split']) for p in keep)
    print(f'откат {len(dropped)}, осталось {dict(n)}')
    print(f'калибровка/holdout: {dict(s)}')


if __name__ == '__main__':
    main()
