"""Загрузка realset с Wikimedia Commons для коридоров реальности (#78).

Типы облаков берутся из подкатегорий Commons (только фото JPEG, без диаграмм):
  cu — Cumulus humilis/mediocris/congestus/fractus;
  ci — Cirrus fibratus/uncinus/spissatus/radiatus + sunset-подкатегории.

На тип: 30 фото калибровки (calib) + 10 отложенных (holdout) — отложенный набор
по вики обязан попадать в коридор, это проверка самих метрик.

Отбор: фильтр размера/формата, отсев серий (совпадение начала имени файла или
почти одинаковый превью-кадр), санити-проверка маски (доля облака 0.10–0.98) и
QC-правила «земля вместо неба» (city/desert/water внизу кадра — см. photo_qc,
откалиброваны на просмотре масок реальных фото).
Фото хранятся шириной 1024 px (нормировка метрик), лицензии и авторы — в manifest.json.

Запуск: python tools/clouds2_bench/fetch_realset.py [--limit 40] [--fresh]
"""
import argparse
import colorsys
import html
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from metrics import WIDTH, cloud_mask, load_image  # noqa: E402

OUT = Path(__file__).resolve().parent / 'realset'
API = 'https://commons.wikimedia.org/w/api.php'
UA = {'User-Agent': 'clouds2-bench/1.0 (research; local Wikimedia fetch for #78)'}

CATEGORIES = {
    'cu': ['Cumulus humilis clouds', 'Cumulus mediocris clouds',
           'Cumulus congestus clouds', 'Cumulus fractus'],
    'ci': ['Cirrus fibratus clouds', 'Cirrus uncinus clouds', 'Cirrus spissatus clouds',
           'Cirrus radiatus clouds', 'Cirrus clouds at sunset'],
}
CALIB, HOLDOUT = 30, 10


def api_get(params):
    url = API + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    delay = 5.0
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if attempt == 5:
                raise
            if '429' in str(e):
                # Wikimedia частит: ждём дольше, ответ Retry-After уважаем
                retry = getattr(getattr(e, 'headers', None), 'get', lambda *_: None)(
                    'Retry-After')
                delay = max(float(retry) if retry and str(retry).isdigit() else 0, delay)
            print(f'  повтор запроса через {delay:.0f} c ({e})…')
            time.sleep(delay)
            delay = min(delay * 2, 60)
        time.sleep(1.0)


def strip_html(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', s or ''))).strip()


def category_files(cat, limit=120):
    """Заголовки файловых страниц категории (только ns=6), по порядку сортировки."""
    titles = []
    cont = {}
    while len(titles) < limit:
        d = api_get({'action': 'query', 'list': 'categorymembers',
                     'cmtitle': 'Category:' + cat, 'cmtype': 'file',
                     'cmlimit': '50', 'format': 'json', **cont})
        titles += [m['title'] for m in d['query']['categorymembers']]
        if 'continue' not in d or len(d['query']['categorymembers']) == 0:
            break
        cont = d['continue']
    return titles[:limit]


def file_info(titles):
    """Метаданные файлов пачками по 20 (imageinfo + extmetadata)."""
    out = {}
    for i in range(0, len(titles), 20):
        chunk = titles[i:i + 20]
        d = api_get({'action': 'query', 'titles': '|'.join(chunk), 'prop': 'imageinfo',
                     'iiprop': 'size|mime|url|extmetadata', 'iiurlwidth': '1600',
                     'format': 'json'})
        for p in d['query']['pages'].values():
            ii = (p.get('imageinfo') or [None])[0]
            if not ii:
                continue
            em = ii.get('extmetadata', {})
            out[p['title']] = {
                'title': p['title'],
                'width': ii.get('width', 0), 'height': ii.get('height', 0),
                'mime': ii.get('mime', ''),
                # оригинал многомегабайтный — берём готовый thumb 1600 px
                'url': ii.get('thumburl') or ii.get('url', ''),
                'author': strip_html(em.get('Artist', {}).get('value', ''))[:120],
                'license': strip_html(em.get('LicenseShortName', {}).get('value', '')),
                'page': 'https://commons.wikimedia.org/wiki/'
                        + urllib.parse.quote(p['title'].replace(' ', '_')),
            }
        time.sleep(1.0)  # вежливость к API (429 от Commons уже ловили)
    return out


def series_key(title):
    """Ключ серии: первые значимые слова имени файла — кадры одного места/минуты
    («2013-05-19 14-49-26-nuages.jpg» vs «…15-12-06-nuages.jpg») считаем дублем.
    Префикс File: снимается — у кандидатов он есть, в manifest нет (иначе ключи
    не сходятся между запусками и одна фото уезжает в оба типа).
    Буквы — юникодные ([^\\W\\d_]): é/ý/ď/à в чешских/французских именах
    рвали слово и ключи расходились между запусками."""
    t = title.lower()
    if t.startswith('file:'):
        t = t[5:]
    words = re.findall(r'[^\W\d_]{3,}', t)
    return ' '.join(words[:3])


def photo_qc(arr, cloud, sky):
    """Причина отказа фото для коридора или None (QC пройден).

    Правила откалиброваны на просмотре масок реальных фото: земля вместо неба
    (городская застройка, пустыня, река, гравий) даёт «облака» внизу кадра,
    а верх при этом пуст/тусклый. Аэро- и обзорные кадры (облака внизу везде)
    наоборот обязаны проходить — у них высокая маска и в верхней трети.
    """
    frac = float(cloud.mean())
    if not (0.10 <= frac <= 0.98) or float(sky.mean()) < 0.01:
        return 'маска'
    h = cloud.shape[0]
    bot = slice(int(0.7 * h), h)
    fb = float(cloud[bot].mean())
    if fb == 0:
        return None
    ft = float(cloud[:int(0.3 * h)].mean())
    smb = float(sky[bot].mean())
    px = cloud[bot]
    vals = arr[bot][px][::7]
    if len(vals) >= 20:
        vb = float(vals.mean())
        hb = float(np.median([colorsys.rgb_to_hsv(*p)[0] * 360 for p in vals]))
    else:
        vb, hb = 1.0, 0.0
    if fb > 0.45 and ft < 0.15:
        return 'земля/город внизу, верх пуст'          # улицы, дворы, террасы
    if fb > 0.50 and vb < 0.50 and 10 <= hb <= 90:
        return 'тёмный тёплый низ (река/город)'        # река на закате, Иль-давид
    if fb > 0.55 and smb < 0.05 and ft < 0.30:
        return 'низ без синего неба (земля/пустыня)'    # тропа среди скал
    return None


# Глазная проверка масок (20.10.2026): фото прошли авто-QC правилами photo_qc,
# но по оверлею маска ловит землю/стройку/воду вместо облака (озеро, море,
# парковка, здание, подсвеченная листва). Не возвращать их при доборе.
EYEBALL_REJECT = {
    '-beforerain -cloudy -blue -sky -HatirJheel -lake -water -dhaka -bangladesh (27222947114).jpg',
    '034 Prachatice ul. Mlýnská u Slepého Mlýna.jpg',
    '2021-10-07 07 28 38 Morning view down below cumulus clouds towards the '
    'Pacific Ocean from an airplane traveling from Honolulu, Oahu to Lihue, '
    'Kauai in Hawaii.jpg',
    'A natural scenery 2.jpg',
    'Apakeqar Emma YSU (4).jpg',
    'Arenas, Nice, France - panoramio (2).jpg',
    'Avenue de la Vauve à Palaiseau le 18 février 2018 - 1.jpg',
    'Basilica of Notre-Dame de Fourvière Panorama.jpg',
    'Bellapais Monastery - Abbey church (03).JPG',
    "Chantier de construction le long de l'avenue de la Vauve à Palaiseau "
    'le 18 février 2018 - 01.jpg',
    'Altayran Rock.jpg',
    'Bratislavia 2022 3.jpg',
    '035 Prachatice ul. Mlýnská pohled na lom Kobylí hory.jpg',
    '2021-10-07 07 29 20 Morning view down below cumulus clouds towards the '
    'Pacific Ocean from an airplane traveling from Honolulu, Oahu to Lihue, '
    'Kauai in Hawaii.jpg',
    'Ephesus3.jpg',
    'AS09-22-3464 - Apollo 9 - Apollo 9 Mission image - Earth Observations '
    '- Texas - NARA - 16674007.jpg',
    'AUT — Tirol — KB — Kitzbühel — Hornweg 23a (Kapelle Maria Heimsuchung · '
    'Kitzbühel und Umgebung) 2024-08-31 Mattes.jpg',
    'Biandintz eta zaldiak - modified2.jpg',
}
# Эти серии целиком отбракованы глазной QC (улицы, блик по морю, снимки из
# космоса, альпийские тропы): точные заголовки не совпали — режем по префиксу.
EYEBALL_SERIES = ('prachatice', 'morning view down', 'apollo', 'aut tirol')


def thumb(arr, size=(32, 18)):
    im = Image.fromarray((arr * 255).astype(np.uint8)).convert('L').resize(size)
    return np.asarray(im, dtype=float)


def near_dup(t, thumbs):
    """Средняя |разность| превью < 6/255 — почти тот же кадр (серия одного места)."""
    return any(np.abs(t - o).mean() < 6 for o in thumbs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=CALIB + HOLDOUT + 14,
                    help='сколько кандидатов рассматривать на тип (с запасом на отсев)')
    ap.add_argument('--fresh', action='store_true', help='перекачать всё заново')
    a = ap.parse_args()

    manifest_path = OUT / 'manifest.json'
    manifest = (json.loads(manifest_path.read_text(encoding='utf-8'))
                if manifest_path.exists() and not a.fresh else {'photos': []})
    have = {p['file'] for p in manifest['photos']}
    seen_series = {series_key(p['title']) for p in manifest['photos']}  # между типами тоже

    for ctype, cats in CATEGORIES.items():
        d = OUT / ctype
        d.mkdir(parents=True, exist_ok=True)
        if a.fresh:  # с чистого каталога, иначе старые файлы займут индексы
            for old in d.glob(f'{ctype}_*.jpg'):
                old.unlink()
        # занятые имена: индекс добирается в свободную дырку, а не счётчиком
        # строк (счётчик перезаписывал уже взятые файлы при доборе после prune)
        used = {Path(p['file']).name for p in manifest['photos']
                if p['type'] == ctype}
        if not a.fresh:  # превью уже взятого — защита от повтора между запусками
            thumbs = [thumb(load_image(OUT / p['file'])) for p in manifest['photos']
                      if p['type'] == ctype and (OUT / p['file']).exists()]
        else:
            thumbs = []
        have_n = sum(1 for p in manifest['photos']
                     if p['type'] == ctype and p['split'] == 'calib')
        hold_n = sum(1 for p in manifest['photos']
                     if p['type'] == ctype and p['split'] == 'holdout')
        if have_n >= CALIB and hold_n >= HOLDOUT:
            print(f'{ctype}: уже собрано {have_n}+{hold_n} — пропуск')
            continue

        titles, seen = [], set()
        for cat in cats:  # приоритет подкатегорий задаёт порядок
            for t in category_files(cat, limit=a.limit):
                if t not in seen and t.lower().endswith(('.jpg', '.jpeg')):
                    seen.add(t)
                    titles.append((cat, t))
        print(f'{ctype}: кандидатов {len(titles)} из {len(cats)} подкатегорий')

        infos = file_info([t for _, t in titles])
        idx = {t: cat for cat, t in titles}
        n_new = 0
        for title in (t for _, t in titles):
            if have_n >= CALIB and hold_n >= HOLDOUT:
                break
            info = infos.get(title)
            if not info or info['mime'] != 'image/jpeg':
                continue
            if min(info['width'], info['height']) < 800 or info['width'] < info['height']:
                continue  # только пейзажные, достаточно крупные
            norm = title[5:] if title.lower().startswith('file:') else title
            if norm in EYEBALL_REJECT:
                continue  # глазная QC: маска ловит землю/стройку/воду вместо облака
            key = series_key(title)
            if key.startswith(EYEBALL_SERIES):
                continue  # вся серия глазной QC отбракована (улицы/море)
            if key in seen_series:
                continue  # серия (одно место/минута) уже в наборе — один объект
            im = None
            for attempt in range(4):  # upload.wikimedia.org тоже может 429
                try:
                    req = urllib.request.Request(info['url'], headers=UA)
                    with urllib.request.urlopen(req, timeout=120) as r:
                        raw = r.read()
                    im = Image.open(io.BytesIO(raw)).convert('RGB')
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 3:
                        print(f'  пропуск {title[:50]}: {e}')
                    else:
                        time.sleep(3 * (attempt + 1))
            if im is None:
                continue
            try:
                im = im.resize((WIDTH, round(im.height * WIDTH / im.width)),
                               Image.LANCZOS)
            except Exception as e:  # noqa: BLE001
                print(f'  пропуск {title[:50]}: {e}')
                continue
            time.sleep(0.5)

            arr = np.asarray(im, dtype=float) / 255.0
            t = thumb(arr)
            if near_dup(t, thumbs):  # серия одного места — метрики задублируются
                continue

            split = 'calib' if have_n < CALIB else 'holdout'
            i = 0
            while (f'{ctype}_{split}_{i:02d}.jpg' in used
                   or (d / f'{ctype}_{split}_{i:02d}.jpg').exists()):
                i += 1  # первое свободное имя (дырки после prune), без перезаписи
            fname = f'{ctype}_{split}_{i:02d}.jpg'
            im.save(d / fname, quality=90)
            # QC по байтам на диске — prune меряет тот же JPEG после декодера;
            # разные измерения (память vs диск) на пограничных фото входили в
            # цикл добор↔откат. Отбор — дефолтной маской: кадровые пороги
            # cool_2 на реальных фото дали 33/40 отката, для коридора не годятся
            disk = load_image(d / fname)
            cloud, sky = cloud_mask(disk)
            reason = photo_qc(disk, cloud, sky)
            if reason:
                (d / fname).unlink()
                continue  # маска мусорная (город/земля внизу) — фото не в коридор
            frac = float(cloud.mean())
            seen_series.add(key)
            used.add(fname)
            print(f'  + {fname}  маска {frac:.2f}  {info["title"][:44]}', flush=True)
            manifest['photos'].append({
                'file': f'{ctype}/{fname}', 'type': ctype, 'split': split,
                'category': idx[title], 'title': title.replace('File:', ''),
                'author': info['author'], 'license': info['license'],
                'source': info['page'],
                'orig': f"{info['width']}x{info['height']}", 'cloud_frac': round(frac, 3),
            })
            have.add(fname)
            thumbs.append(t)
            n_new += 1
            if split == 'calib':
                have_n += 1
            else:
                hold_n += 1
        print(f'{ctype}: скачано {n_new} (калибровка {have_n}/{CALIB}, holdout {hold_n}/{HOLDOUT})')

    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                             encoding='utf-8')
    print(f'итог: {len(manifest["photos"])} фото → {manifest_path}')


if __name__ == '__main__':
    main()
