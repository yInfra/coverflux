# Coverflux

**Beat-synchroner Cover-Visualizer für den Browser und für Spotify Desktop ([Spicetify](https://spicetify.app)).** [English](README.md)

**[▶ Im Browser ausprobieren](https://yinfra.github.io/coverflux/)**: Datei abspielen, Tab-, System- oder Mikrofonton live, auf Desktop und Handy, ohne Upload.

Ein Knopf in der Playbar neben dem Lyrics-Knopf verwandelt alles oberhalb der Playbar in einen Visualizer. Er morpht das Cover des laufenden Songs oder der Playlist im Takt durch mathematische Abbildungen: Kaleidoskope, hyperbolische Kachelungen, Droste-Spiralen, Kreisinversionen. Jeder Effekt ist eine geschlossene Bewegung und landet immer wieder exakt auf dem Original. Je ruhiger die Musik, desto mehr Original bleibt sichtbar.

| Vollbild | Quadrat |
| --- | --- |
| ![Kaleido im Vollbild](docs/preview-kaleido.png) | ![Quadrat mit leuchtender Spiegelung](docs/preview-square.png) |

<sub>Die Vorschaubilder stammen aus dem Test-Harness und zeigen generierte Test-Cover.</sub>

## Installation

Voraussetzung ist die [Spicetify CLI](https://spicetify.app/docs/getting-started).

```bash
git clone https://github.com/yInfra/coverflux.git
cd coverflux
```

| System | Befehl |
| --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File .\install.ps1` |
| macOS / Linux | `sh ./install.sh` |

Danach Spotify neu starten. Ohne Git reicht auch die fertige Datei [`dist/coverflux.js`](dist/coverflux.js): in den Spicetify-Ordner `Extensions` legen, dann `spicetify config extensions coverflux.js` und `spicetify apply` ausführen.

> **Nach jedem Spotify-Update** ist der Spicetify-Patch weg. Dann `spicetify backup apply` ausführen oder den Installer erneut starten.

## Bedienung

| Element | Funktion |
| --- | --- |
| Playbar-Knopf | Visualizer öffnen oder schließen, `Esc` schließt ebenfalls |
| **Modus-Chip** | Zeigt den laufenden Modus und öffnet die Modus-Liste. **Auto** wechselt zwischen allen Modi mit Häkchen. Ein Klick auf eine Zeile lässt nur diesen Modus laufen. **Alle** und **Keine** setzen die Häkchen. Darunter sitzt die Intensität. |
| **BPM-Chip** | Der Punkt blinkt auf jedem gefühlten Beat. Er öffnet das Tempo-Panel mit der Erkennung, dem Verhältnis pro Song (Auto, ½, 1×, 2×, ⅓), **Tap**, der **eigenen Beat-Analyse** und **Sync**. |
| Vollbild / Quadrat | Vollbild: das Cover gespiegelt über die ganze Fläche. Quadrat: das Cover bleibt ein Quadrat mit weichem, wabbelndem Rand in einer leuchtenden, verschwommenen Spiegelung. |
| `T` | Tap: mindestens viermal im Takt drücken. Das setzt Tempo und Beat-Lage für diesen Song. |
| `[` und `]` | Sync in 10-ms-Schritten, bis ±250 ms, etwa bei Bluetooth-Latenz |

### Eigene Beat-Analyse

Spotify liefert für lokale Dateien keine Audio-Analyse, und bei manchen Songs liegt sein Beat-Raster daneben. Darum hat Coverflux eine eigene Beat-Erkennung.

1. Im Tempo-Panel **Ordner wählen** oder **Dateien** anklicken.
2. Coverflux dekodiert und analysiert die Dateien direkt in Spotify. Nichts wird hochgeladen. Die Analyse braucht etwa 1 Sekunde pro Song und läuft in einem Hintergrund-Thread.
3. Die Ergebnisse bleiben im Browser-Speicher von Spotify. Beim Abspielen findet Coverflux den Song über Titel (ID3-Tag oder Dateiname wie „Interpret - Titel“), Interpret und Dauer.
   - **Lokale Dateien** nutzen die Analyse direkt.
   - **Spotify-Songs** nutzen sie, wenn dieselbe Aufnahme als Datei vorliegt. Coverflux legt dazu den Lautstärkeverlauf der Datei auf Spotifys Version. Downloads mit anderem Anfang werden so automatisch verschoben. Passt die Datei nicht, bleibt Spotifys Analyse.

**Unterstützte Formate:** MP3, FLAC, WAV, OGG und Opus. M4A und AAC nur, wenn Spotifys eingebauter Browser die Codecs mitbringt.

**Wie die Erkennung arbeitet:**
- Sie berechnet ein Log-Band-Spektrogramm und findet darin Einsätze (Spectral Flux mit SuperFlux-Maxfilter).
- Das Tempo ergibt sich aus der ganzen metrischen Familie der Autokorrelation.
- Die Beats legt sie mit dynamischer Programmierung (Ellis 2007), verfeinert auf weniger als ein Analyse-Fenster.
- Taktanfänge erkennt sie an Akkordwechseln und Bass-Schlägen, Dreier- und Vierertakt unterscheidet sie.
- In Intros und Outros ohne klaren Puls setzt sie das Raster gleichmäßig fort.

**Genauigkeit:** Gegen das neuronale Referenzmodell Beat This! (CPJKU) erreicht sie auf Hip-Hop- und Pop-Songs im Groove 97 bis 100 % Beat-Treffer bei ±70 ms. Taktanfänge trifft sie zu 76 bis 96 %. Gemessen wird mit `npm run beat-eval`.

### Tempo-Regeln

- Der gefühlte Puls bleibt bei höchstens 140 BPM. Schnellere Songs laufen auf Schlag 1 und 3 jedes Takts.
- Dreiertakt (3/4, 6/8) wird nie halbiert, sondern bekommt einen Puls pro Takt.
- Für Spotifys eigene Analyse prüft Coverflux das Raster: Tempo aus der mittleren Schlaglänge, Erkennung von Dreiertakt und Korrektur eines Rasters auf dem Offbeat.

## Modi

Jeder Song-Abschnitt wird in Zyklen von rund 16 Takten aufgeteilt. An jeder Zyklusgrenze ist exakt das Original zu sehen. Auto wechselt nur dort, also unsichtbar, und wählt je nach Energie einen ruhigen oder lauten Modus unter denen mit Häkchen. Jeder Punkt läuft auf einer geschlossenen Bahn, die nur vorwärts geht. Er startet und landet von der Mitte nach außen versetzt.

| Gruppe | Modus | Effekt | Mathematik |
| --- | --- | --- | --- |
| Fluss | Liquid | Marmorstrom, fließt eine Spiegel-Periode weiter | Sinus-Domain-Warping |
| | Ripple | Wasser zieht quer durchs Bild | Wellenfeld mit Brechung |
| | Vortex | Ringe drehen volle Runden | radial verzögerte Rotation |
| | Prism | Geriffeltes Glas, Regenbogenkanten | Brechung an Rippen, Dispersion |
| | Tunnel | Droste-Tauchgang, eine Periode tiefer | Log-Polar-Periodizität |
| Symmetrie | Kaleido | Faltet sich von innen nach außen | Diedergruppe D_n |
| | Mandala | Kaleido auf einer Spirale | D_n mit logarithmischem Radius |
| | Hexa | Waben mit sechsfacher Spiegelung | Tapetengruppe p6m |
| | Rosette | Blütenblätter | Winkelvervielfachung (z ↦ zⁿ) |
| | Moiré | Zwei Kaleido-Gitter überlagern sich | Schwebung zweier Gitter |
| | Quasikristall | Fünf- oder siebenzählig, wiederholt sich nie | Überlagerte ebene Wellen |
| Fraktal | Fractal | Faltet sich Stufe für Stufe | iterierte Box-Faltung |
| | Sierpinski | Dreiecke voller Dreiecke | IFS mit drei Kontraktionen |
| | Inversion | Perlenketten | Apollonische Kreisinversion |
| | Phyllotaxis | Sonnenblumen-Spirale aus Mini-Covern | goldener Winkel, Voronoi |
| Raum | Escher-Spirale | Dreht sich endlos in sich selbst | Droste-Effekt mit Drehung |
| | Hyperbolisch | Poincaré-Scheibe, Kacheln strömen | {7,3}-Kachelung, Möbius-Translation |
| | Dreiecksgruppe | Dreiecks-Kaleidoskop, Winkel wandern | (P,4)-Schwarz-Dreiecke |
| | Sphäre | Ikosaeder-Kugel, rollt einmal | Ikosaedergruppe auf S² |
| | Möbius-Strom | Fließt von einem Pol in den anderen | loxodromische Möbius-Transformation |

Bei `prefers-reduced-motion` gibt es keine Drehungen und deutlich weniger Ausschlag.

## Entwicklung

```text
src/beat-engine.js     Beat-Erkennung (reines JS, Worker, Browser und Node)
src/core.js            der Visualizer: Renderer, Shader, Audio-Modell, Bibliothek, UI (Host-Schnittstelle)
src/adapters/          spicetify.js (Spotify Desktop), web.js (Browser)
web/                   Web-App (index.html + Bundle), auf GitHub Pages
dist/coverflux.js      Spicetify-Bundle (`npm run build`, wird mit committet)
test/harness.html      nachgebautes Spicetify und Spotify-Layout mit generierten Covern
test/*.test.mjs        Engine auf synthetischen Drum-Tracks, Raster-Prüfung, Bibliothek
tools/                 Build, Kontaktbogen der Modi, UI-Screenshots, Vorschaubilder, Beat-Auswertung
tools/analyze/         nur Entwicklung: Referenz-Beats mit Beat This! (Python)
```

```bash
npm install            # Playwright für Tests und Screenshots
npm test               # Syntax-Checks und alle Tests (headless)
npm run build          # dist/coverflux.js neu bauen, nach jeder Änderung in src/
npm run serve          # Harness unter http://localhost:8765/test/harness.html
npm run modes          # Kontaktbogen aller Modi über den Zyklus (braucht lokales Chrome mit GPU)
npm run beat-eval -- song.mp3   # Engine gegen Referenz-Beats messen (siehe tools/analyze/)
```

- Debuggen in den Spotify-DevTools: `Coverflux.open()`, `Coverflux.state`, `Coverflux.audio.describe()` und `Coverflux.library`. Mit `Coverflux.state.forceU = 0..1` frierst du einen Zyklus ein.
- Versionen sind Git-Tags, die Änderungen stehen im [CHANGELOG](CHANGELOG.md).
- GitHub Actions führt die Tests aus und prüft, dass `dist/` aktuell ist.
