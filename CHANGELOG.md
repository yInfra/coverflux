# Changelog

## v2.5 — Beat-Raster-Prüfung
- Das Tempo kommt aus der mittleren Schlaglänge des Rasters statt aus Spotifys Kopfzahl.
- Dreiertakt (3/4, 6/8) wird erkannt, auch wenn Spotify 4/4 meldet, und nie halbiert.
- Ein Raster auf dem Offbeat wird um einen halben Schlag korrigiert, bei Halbtempo zählt der stärkere Schlag.
- Tap-Tempo (Knopf oder `T`) gilt pro Song. Der BPM-Knopf hat jetzt zusätzlich ⅓.
- Der Punkt im BPM-Knopf blinkt auf jedem gefühlten Beat, der Tooltip zeigt die Erkennung.
- Fix: Im Quadrat-Modus bleibt die Quadrat-Maske jetzt am Bildschirm stehen. Vorher falteten Effekte scharfe Cover-Reste vom Rand ins Bild.
- Repo-Aufbau: Tests, CI, Vorschaubilder.

## v2.4 — Playbar-Leuchten
- Die Unterkante des Visuals spiegelt sich verschwommen in der Playbar, wie eine OLED-Reflexion, im Maßstab 1:1 und pixelgenau ausgerichtet.
- Shatter entfernt.

## v2.3 — Vollbild oder Quadrat
- Neuer Umschalter. Quadrat: weicher, wabbelnder Rand mit dunkler, verschwommener, leuchtender Spiegelung.

## v2.2 — Länger und im Takt
- Zyklen sind jetzt etwa 16 Takte lang, sodass ein ganzer Kaleido-Durchlauf ohne Unterbrechung läuft.
- Über 140 BPM wird halbiert.
- Die Bewegung läuft stetig und beschleunigt auf jedem Beat. Mandala läuft länger und flüssiger.

## v2.1 — Geschlossene Bahnen
- Jeder Punkt läuft auf einer geschlossenen Bahn, die nur vorwärts geht und auf dem Original endet.
- Die Phasen zurück zum Original sind deutlich länger.
- Prism-Ecken und Kaleido-Morph überarbeitet.

## v2.0 — Neuer Renderer
- WebGL2-Pipeline mit Szenen- und Present-Pass. Die Zyklen richten sich nach den Abschnitten des Songs.

## v1 — Erste Version
- Playbar-Knopf, Cover-Morph zur Spotify-Audio-Analyse.
