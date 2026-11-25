# Coverflux

**Beat-synchroner Cover-Visualizer für Spotify Desktop ([Spicetify](https://spicetify.app)).**

Ein Knopf in der Playbar neben dem Lyrics-Knopf verwandelt alles oberhalb der Playbar in einen Visualizer. Er morpht das Cover des laufenden Songs oder der Playlist im Takt der Musik. Jeder Effekt läuft in einer geschlossenen Bewegung und landet immer wieder exakt auf dem Original. Je ruhiger die Musik, desto mehr Original bleibt sichtbar.

| Vollbild | Quadrat |
| --- | --- |
| ![Kaleido im Vollbild](docs/preview-kaleido.png) | ![Quadrat mit leuchtender Spiegelung](docs/preview-square.png) |

<sub>Die Vorschaubilder stammen aus dem Test-Harness und zeigen generierte Test-Cover.</sub>

## Installation

Voraussetzung ist die [Spicetify CLI](https://spicetify.app/docs/getting-started).

```powershell
git clone https://github.com/yInfra/coverflux.git
cd coverflux
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Danach Spotify neu starten.

> **Nach jedem Spotify-Update** ist der Spicetify-Patch weg. Dann `spicetify backup apply` ausführen (oder `install.ps1` erneut). Falls dabei „backup version mismatched“ erscheint, vorher `spicetify restore backup apply` ausführen.

## Bedienung

| Element | Funktion |
| --- | --- |
| Playbar-Knopf | Visualizer öffnen oder schließen, alternativ mit `Esc` schließen |
| Modi-Chip | Zeigt den laufenden Modus. Er öffnet das Modi-Panel: Ein Klick auf eine Kachel nimmt den Modus in Auto auf oder heraus, ein Doppelklick lässt nur diesen laufen („Fix“), **Alle** setzt zurück. Darunter sitzt die Intensität. |
| Vollbild / Quadrat (Symbol) | Vollbild: das Cover breitet sich gespiegelt über die ganze Fläche aus. Quadrat: das Cover bleibt ein Quadrat mit weichem, wabbelndem Rand in einer verschwommenen, leuchtenden Spiegelung. |
| BPM-Chip | Der Punkt blinkt auf jedem gefühlten Beat. Er öffnet das Tempo-Panel mit Erkennung, Verhältnis pro Song (Auto, ½, 1×, 2×, ⅓), **Tap** und **Sync**. |
| `T` | Tap: mindestens viermal im Takt drücken. Das setzt Tempo und Beat-Lage für diesen Song. |
| `[` und `]` | Sync: verschiebt die Visuals in 10-ms-Schritten, bis ±250 ms, etwa bei Bluetooth-Latenz. |
| `Esc` | Schließt erst ein offenes Panel, dann den Visualizer. |

## Wie es funktioniert

- **Zyklen:** Jeder Song-Abschnitt wird in Zyklen von rund 16 Takten aufgeteilt. An jeder Zyklusgrenze und jedem Abschnittsanfang ist exakt das Original zu sehen. Auto wechselt nur dort den Modus, also unsichtbar, und wählt je nach Energie einen ruhigen oder lauten unter den aktiven Modi.
- **Immer vorwärts:** Jeder Bildpunkt läuft auf einer geschlossenen Bahn, die genau dort endet, wo sie begonnen hat. Die Bahn ist eine volle Drehung, eine Spiegel-Periode Drift, ein Orbit oder eine Droste-Periode. Jeder Punkt hat dabei seine eigene, leicht versetzte Uhr. Daraus entstehen Spiralen, Ströme und Faltungen, nichts läuft rückwärts.
- **Beat:** Die Bewegung läuft stetig und beschleunigt auf jedem Beat, in lauten Passagen stärker. Dazu kommt ein kleiner Zoom-Puls.
- **Tempo und Raster:** Grundlage ist Spotifys Audio-Analyse, deren Beat-Raster Coverflux selbst prüft.
  - Das Tempo kommt aus der mittleren Schlaglänge, nicht aus Spotifys Kopfzahl.
  - Dreiertakt (3/4, 6/8) wird erkannt, auch wenn Spotify 4/4 meldet, und nie halbiert.
  - Ein Raster, das auf dem Offbeat liegt, wird um einen halben Schlag korrigiert.
  - Bei Halbtempo zählt der stärkere Schlag.
  - Der gefühlte Puls bleibt bei höchstens 140 BPM.
- **Playbar-Leuchten:** Die Unterkante des Visuals spiegelt sich verschwommen in der schwarzen Playbar, wie eine OLED-Reflexion.
- **Fallback:** Ohne Audio-Analyse, etwa bei lokalen Dateien, läuft ein simulierter Takt. Das wird angezeigt.
- **Reduzierte Bewegung:** Bei `prefers-reduced-motion` gibt es keine Drehungen und deutlich weniger Ausschlag.

### Modi

| Modus | Effekt |
| --- | --- |
| Liquid | Marmorstrom, der eine volle Spiegel-Periode weiterfließt |
| Vortex | Ringe machen volle Drehungen, das Auge führt, der Rand holt auf |
| Ripple | Wasser zieht von einer Seite herein und auf der anderen hinaus |
| Prism | geriffeltes Glas mit Regenbogenkanten |
| Kaleido | faltet sich von der Mitte nach außen und entfaltet sich in dieselbe Richtung |
| Mandala | Kaleido mit logarithmischer Spirale |
| Fractal | faltet sich Stufe für Stufe ein und in derselben Reihenfolge wieder aus |
| Tunnel | Droste-Tauchgang, der genau eine Periode tiefer endet |

Ideen für weitere Modi stehen in [docs/modi-ideen.md](docs/modi-ideen.md).

## Entwicklung

```text
src/coverflux.js       die Extension (eine Datei, kein Build)
test/harness.html      nachgebautes Spicetify und Spotify-Layout mit generierten Covern
test/grid.test.mjs     Tests für Tempo, Takt und Raster (laufen gegen den Harness)
tools/preview.mjs      erzeugt docs/preview-*.png
tools/ui-shot.mjs      Screenshot mit sichtbarer Steuerung, optional mit offenem Panel
install.ps1            installiert die Extension und wendet Spicetify an
```

```bash
npm install          # Playwright für die Tests
npm test             # Syntax-Check und Raster-Tests (headless)
npm run serve        # Harness unter http://localhost:8765/test/harness.html
npm run preview      # Vorschaubilder neu rendern (braucht lokales Chrome mit GPU)
```

- Der Harness mit `?noanalysis` testet den Fallback.
- Debuggen in den Spotify-DevTools: `Coverflux.open()`, `Coverflux.state` und `Coverflux.audio.describe()`. Mit `Coverflux.state.forceU = 0..1` frierst du einen Zyklus ein, `null` gibt ihn wieder frei.
- Schnelles Update ohne Installer: `src/coverflux.js` nach `%APPDATA%\Spotify\Apps\xpui\extensions\` kopieren und Spotify neu starten.
- Versionen sind Git-Tags (`v1` … `v2.6`), die Änderungen stehen im [CHANGELOG](CHANGELOG.md). Die Versionsnummer steht oben in `src/coverflux.js` und in `package.json`.
- GitHub Actions führt `npm test` bei jedem Push aus.
