"""Визуальная проверка масок облаков: рисует overlay (оранжевый — облако, синий — небо).

    python tools/clouds2_bench/overlay_mask.py [имя ...]

Без аргументов — все три сцены (референс + снимок view 0). Настройки берутся
из scenes.json (mask.<scene>, перекрытие ref — для эталонного фото).
Результат: mvp_clouds2/test/shots/_mask_<имя>.png (не в git, для ручной проверки).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from metrics import cloud_mask, load_image  # noqa: E402

SCENES = ROOT / 'mvp_clouds2' / 'test' / 'scenes.json'
SHOTS = ROOT / 'mvp_clouds2' / 'test' / 'shots'


def scene_cfgs(name: str, masks: dict) -> tuple[dict | None, dict | None]:
    """(cfg снимка, cfg референса) для сцены — как в metrics.py main()."""
    base = masks.get(name) or {}
    cfg = {k: v for k, v in base.items() if k != 'ref'} or None
    ref_cfg = {**base, **base.get('ref', {})}
    ref_cfg.pop('ref', None)
    return cfg, (ref_cfg or None)


def draw(name: str, path: Path, cfg: dict | None) -> None:
    rgb = load_image(path)
    cm, sm = cloud_mask(rgb, cfg)
    out = (rgb * 255).astype(np.uint8).copy()
    out[cm] = (out[cm] * 0.35 + np.array([255, 60, 0]) * 0.65).astype(np.uint8)
    out[sm] = (out[sm] * 0.35 + np.array([0, 80, 255]) * 0.65).astype(np.uint8)
    Image.fromarray(out).save(SHOTS / f'_mask_{name}.png')
    print(f'{name:<10} cloud={cm.mean():.3f} sky={sm.mean():.3f} → _mask_{name}.png')


def main() -> None:
    scenes = json.loads(SCENES.read_text(encoding='utf-8'))
    masks = scenes.get('mask', {})
    only = set(sys.argv[1:])
    for name, sc in scenes['scenes'].items():
        shot_cfg, ref_cfg = scene_cfgs(name, masks)
        ref = (SCENES.parent / sc['ref']).resolve() if sc.get('ref') else None
        if ref and ref.exists() and (not only or f'{name}_ref' in only or name in only):
            draw(f'{name}_ref', ref, ref_cfg)
        for view in scenes.get('views', []):
            png = SHOTS / f'{name}_{view}.png'
            key = f'{name}_{view}'
            if png.exists() and (not only or key in only or name in only):
                draw(key, png, shot_cfg)


if __name__ == '__main__':
    main()
