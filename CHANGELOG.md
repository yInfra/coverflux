# Changelog

## v3.1 — Plattformübergreifend und Open Source
- **Kern und Anbindungen getrennt:** `createCoverflux(host)` in src/core.js, src/adapters/spicetify.js für Spotify Desktop, src/adapters/web.js für den Browser.
- **Web-App:** Dateien abspielen mit exakter Analyse und Cover aus den Tags, Tab- oder Systemton und Mikrofon live, eigenes Bild als Cover, Drag & Drop, Desktop und Handy. Läuft über GitHub Pages.
- **Live-Beat-Tracking** (createLive):
  - PI-Regelschleife, zwei Schätzungen (geführt und frei), festgeschriebene Beats bewegen sich nie.
  - Gegen Beat This! gemessen: 80 bis 84 %.
- **Deutsch und Englisch** in der ganzen Oberfläche.
- **Open Source:** MIT-Lizenz, englisches README, Spicetify-Marketplace-Manifest, Vorlagen für Issues, CONTRIBUTING, Pages-Workflow.

## v3.0 — Eigene Beat-Erkennung, 12 neue Modi, Modus-Liste
- **Eigene Beat-Erkennung** (src/beat-engine.js, reines JS):
  - Spektrogramm, Spectral Flux, Tempo über die metrische Familie, DP-Beat-Tracking, Takt und Taktanfänge, Abschnitte, Segmente im Format von Spotifys Analyse.
  - Läuft in Spotify in einem Hintergrund-Thread, ohne Installation und plattformübergreifend.
  - Gegen Beat This! gemessen: 97 bis 100 % Beat-Treffer im Groove.
- **Bibliothek:**
  - Ordner oder Dateien im Tempo-Panel analysieren, gespeichert in IndexedDB.
  - Zuordnung über ID3-Tag oder Dateiname plus Dauer.
  - Spotify-Songs werden über den Lautstärkeverlauf mit der Datei abgeglichen (Grob- und Feinsuche).
  - Lokale Dateien bekommen endlich echte Beats.
- **12 neue Modi:** Hexa, Quasikristall, Hyperbolisch, Escher-Spirale, Inversion, Rosette, Phyllotaxis, Sphäre, Sierpinski, Moiré, Möbius-Strom, Dreiecksgruppe.
- **Modus-Liste:**
  - Ein Klick auf eine Zeile wählt einen festen Modus, Häkchen legen fest, was in Auto läuft.
  - Gruppiert nach Fluss, Symmetrie, Fraktal und Raum.
  - Neue Modi sind in Auto automatisch an.
- **Plattformübergreifend:** dist/coverflux.js als fertiges Bundle (`npm run build`, CI prüft es), install.sh für macOS und Linux.
- **Werkzeuge:** tools/modes-sheet.mjs (Kontaktbogen und Shader-Check), tools/beat-eval.mjs und tools/analyze/ (Referenzmessung).

## v2.6 — Modi-Auswahl und neue Steuerung
- Jeder Modus lässt sich für Auto an- und abschalten. Ein Doppelklick lässt nur einen Modus laufen, die Auswahl wird gespeichert.
- Die alte Einstellung für einen festen Modus wird übernommen.
- Auto wählt nach Energie unter den aktiven Modi.
- Neue Steuerung: eine schlanke Leiste mit Quelle, Modi-Chip (zeigt den laufenden Modus), BPM-Chip mit Beat-Punkt, Vollbild/Quadrat als Symbol und Schließen.
- Modi-Panel mit Kacheln und Intensität. Tempo-Panel mit Erkennung, Verhältnis, Tap-Fläche und Sync.
- `Esc` schließt zuerst das Panel. Solange ein Panel offen ist, blendet sich die Steuerung nicht aus.
- docs/modi-ideen.md: zwölf mathematische Konzepte für neue Modi.

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
