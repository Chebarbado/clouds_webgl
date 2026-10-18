# Фото-референсы облаков

Источник: Wikimedia Commons (заглавные фото статей Википедии о типах облаков), уменьшены до 1000 px.
Используются только как визуальный ориентир для настройки генератора, в проект не встраиваются.

| Файл | Тип | Автор | Лицензия | Источник |
|---|---|---|---|---|
| `cu_humilis.jpg` | Cumulus humilis | Rasbak | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Cumulus_humilis.jpg |
| `cu_mediocris.jpg` | Cumulus mediocris | Gadfium | Public domain | https://commons.wikimedia.org/wiki/File:Mt_Eden%2C_Auckland2.jpg |
| `cu_congestus.jpg` | Cumulus congestus | Bidgee | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Cumulus_congestus_cloud.jpg |
| `cb_calvus.jpg` | Cumulonimbus calvus | Ximonic, Simo Räsänen | GFDL | https://commons.wikimedia.org/wiki/File:Cumulonimbus_seen_from_Milano-Malpensa_airport%2C_2010_08.JPG |
| `cb_incus.jpg` | Cumulonimbus incus (с высоты) | Hussein Kefel | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:A_Classic_Anvil_Cloud_Over_Europe.jpg |
| `cumulonimbus.jpg` | Cumulonimbus incus (с земли) | Kamil Nowacki | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Cumulonimbus_incus_over_Warsaw%2C_Poland.jpg |
| `stratocumulus.jpg` | Stratocumulus (сверху) | Arun Kulshreshtha | CC BY 3.0 us | https://commons.wikimedia.org/wiki/File:Above_the_Clouds.jpg |
| `altocumulus.jpg` | Altocumulus | Bidgee | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Altocumulus.jpg |
| `altostratus.jpg` | Altostratus undulatus | Famartin | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:2020-12-31_16_06_58_Altostratus_with_a_wavy_undulating_base_above_the_Dulles_section_of_Sterling%2C_Loudoun_County%2C_Virginia.jpg |
| `nimbostratus.jpg` | Nimbostratus |  | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Ns1.jpg |
| `stratus.jpg` | Stratus (сверху, море облаков) | kallerna | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Stratus_clouds_Vodno_4.jpg |
| `cirrus.jpg` | Cirrus | PiccoloNamek | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:CirrusField-color.jpg |

## Что взято из референсов

- **Cu humilis** — в 2–3 раза шире высоты, плоское тёмное основание, много мелких и мало крупных → `aspect 0.3`, `skew 1.6`.
- **Cu mediocris / congestus** — сливаются в массивы, башенки разной высоты, резкая «цветная капуста» сверху и рыхлый низ → пузыри + smooth-union ячеек, `billowTop 1 / billowBottom 0.3`.
- **Cb incus** — башня и тонкая плоская наковальня, расширяющаяся кверху и сносимая ветром, волокнистые края → профиль наковальни `pow(a, 1.3)`, канал «клубистости» 0 в наковальне.
- **Sc сверху** — сплошное бугристое море с тёмными промежутками → `deck`, плотная сетка `spacing 1.6`.
- **Ac** — мелкие «барашки» рядами с просветами → `rows 0.6`.
- **As** — серый ровный слой с волнистым основанием → `wave`.
- **St сверху** — ровное море облаков; **Ns** — бесформенный серый с рваным низом; **Ci** — тонкие волокна по ветру.
- **Свет**: освещённая сторона белая, теневая голубовато-серая, насыщенно-синее небо в зените, основания тёмные → слабее ambient, голубой ambient, powder-эффект, ясный день по умолчанию (видимость 100 км).

## Технические источники подхода

- A. Schneider, «The Real-time Volumetric Cloudscapes of Horizon Zero Dawn», SIGGRAPH 2015 Advances — эрозия billow/wispy по высоте, powder, Perlin-Worley.
- A. Schneider, «Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine», SIGGRAPH 2017; «Nubis³: voxel-based clouds», SIGGRAPH 2023 — воксельные облака + детализирующий шум при рендере.
- S. Hillaire, «Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite», SIGGRAPH 2016 — энергосберегающее интегрирование.
- M. Wrenninge et al., «Oz: The Great and Volumetric», SIGGRAPH 2013 Talks — октавы многократного рассеяния.
