# Volumetric Clouds (WebGL)

Генератор 3D density volume для объёмных облаков и его визуализация в браузере (three.js / WebGL2).

**Демо (GitHub Pages):** https://chebarbado.github.io/clouds_webgl/

- [3D-облака](https://chebarbado.github.io/clouds_webgl/mvp_clouds/index.html) — 14 типов облачности, слои, солнце, видимость, метеорадар
- [Метеомодель](https://chebarbado.github.io/clouds_webgl/mvp_clouds/meteo.html) — облака из метеоданных: Skew-T, циклон с фронтами, вертикальный разрез, передача слоёв в 3D

Нужен браузер с WebGL2 (Chrome, Edge, Firefox) и дискретная видеокарта для комфортной частоты кадров.

## Состав

| Путь | Что |
|---|---|
| `mvp_clouds/` | MVP: генератор объёма (шейдеры), рендер, интерфейс; подробности — `mvp_clouds/README.md` |
| `mvp_clouds/js/meteo/` | модель облакообразования и её демонстрация |
| `docs/meteo_model.md` | математическая модель облакообразования |

Локальный запуск: `mvp_clouds/start.bat` (нужен Python) → http://localhost:8080/
