# Coverflux – Cover-Morph-Visualizer für Spotify Desktop (Spicetify)

Ein zusätzlicher Knopf rechts in der Playbar (neben dem Lyrics-/Karaoke-Knopf) verwandelt alles **außer der unteren Playbar** in einen Visualizer, der das Cover des laufenden Songs (oder der Playlist) zur Musik morpht.

## Verhalten (v2.5)
- **Bildfläche umschalten:** Der Knopf „Vollbild“ / „Quadrat“ in der Steuerleiste wird gespeichert.
  - Vollbild: Das Cover breitet sich gespiegelt über den ganzen Bereich aus.
  - Quadrat: Das Cover bleibt ein Quadrat mit weichem, mitwabberndem Rand. Ringsum liegt eine dunklere, verschwommene Spiegelung, die aus dem Cover herausglüht.
  - Der Wechsel wird sanft überblendet.
- **Playbar-Leuchten:** Die schwarze Playbar spiegelt die Unterkante des Visuals verschwommen wie eine OLED-Reflexion und blendet nach unten aus.
- **Ein Zyklus dauert etwa 16 Takte.** Jeder Song-Abschnitt wird in ganze Zyklen von rund 16 Takten aufgeteilt, kürzere Abschnitte bilden einen einzigen Zyklus. Der Effekt ist etwa 60 % davon voll ausgeprägt. An jedem Abschnittsanfang und an jeder Zyklusgrenze ist exakt das Original zu sehen.
- **Immer vorwärts:** Jeder Punkt läuft auf einer geschlossenen Bahn, die nur vorwärts geht und genau dort endet, wo sie begonnen hat. Die Bahn ist eine volle Drehung, eine Spiegel-Periode Drift, ein Orbit oder eine Droste-Periode. Nichts läuft rückwärts, nichts wird überblendet.
- **Jeder Punkt hat seine eigene Uhr:** Punkte starten und landen leicht versetzt, je nach Mitte, Rand, Richtung oder Scherbe. Dieser Versatz ist das, was das Bild in Spiralen, Ströme und Faltungen biegt.
- **Beat:** Die Bewegung läuft stetig weiter und beschleunigt auf jedem Beat, in lauten Passagen stärker. Dazu kommt ein kleiner Zoom-Puls. Je ruhiger die Musik, desto näher bleibt das Bild am Original.
- **Tempo und Beat:** Das Modul folgt Spotifys Beat-Raster und prüft es selbst.
  - Das Tempo kommt aus der mittleren Schlaglänge des Rasters, nicht aus Spotifys BPM-Angabe.
  - Es erkennt Dreiertakt (3/4, 6/8), auch wenn Spotify 4/4 meldet. Dreiertakt wird nie halbiert, sondern bei Bedarf auf einen Puls pro Takt gesetzt.
  - Es erkennt ein Raster, das um einen halben Schlag daneben liegt, und korrigiert es.
  - Bei Halbtempo nimmt es den stärkeren der beiden Schläge.
  - Der gefühlte Puls bleibt bei höchstens 140 BPM.
- **Kontrolle:** Der Punkt im BPM-Knopf blinkt auf jedem gefühlten Beat, der Tooltip zeigt die Erkennung. Die Konsole meldet sie als `[Coverflux] Raster:`.
- **Korrigieren:** Der BPM-Knopf schaltet pro Song zwischen Auto, ½, 1×, 2× und ⅓. Mit **Tap** (oder `T`) klopfst du mindestens viermal im Takt. Das setzt Tempo und Beat-Lage für diesen Song und wird gespeichert. Der Sync-Regler oder die Tasten `[` und `]` verschieben alles um ±250 ms.
- **Modi:**
  - Liquid: Marmorstrom, der eine volle Spiegel-Periode weiterfließt
  - Vortex: jeder Ring macht volle Drehungen, das Auge führt, der Rand holt auf
  - Ripple: Wasser zieht von einer Seite herein und auf der anderen wieder hinaus
  - Prism: geriffeltes Glas mit Regenbogenkanten
  - Kaleido und Mandala: falten sich von der Mitte nach außen und entfalten sich in derselben Richtung
  - Fractal: faltet sich Stufe für Stufe ein und in derselben Reihenfolge wieder aus
  - Tunnel: Droste-Tauchgang, der genau eine Periode tiefer endet
- **Auto:** Pro Zyklus läuft ein Modus. Gewechselt wird nur, wenn das Original zu sehen ist. Manueller Moduswechsel und Pause führen jeden Punkt sanft nach Hause.
- **Fallback:** Ohne Spotify-Analyse, etwa bei manchen Remastern und bei lokalen Dateien, wird der Takt simuliert.
- Versionen sind Git-Tags (`v1`, `v2.0` bis `v2.5`). Eine alte Version holst du mit `git show v2.3:src/coverflux.js > coverflux.js`. Zum Testen lässt sich ein Zyklus mit `Coverflux.state.forceU = 0..1` einfrieren, `null` gibt ihn wieder frei.

## Status (22.11.2026)
- Installiert und angewendet auf Spotify 1.3.10.2586 mit Spicetify v2.46.7. Die CLI liegt unter `%LOCALAPPDATA%\spicetify\spicetify.exe`, steht aber **nicht im PATH**.
- Im echten Spotify getestet. Die Audio-Analyse funktioniert, die Visuals reagieren also auf die echte Musik.
- **Nach jedem Spotify-Update** ist der Patch weg. Dann einfach diesen Befehl ausführen:
  ```powershell
  & "$env:LOCALAPPDATA\spicetify\spicetify.exe" backup apply
  ```
  Falls dabei „backup version mismatched“ erscheint, vorher `spicetify restore backup apply` versuchen.
- Für ein schnelles Update nach Codeänderungen `src/coverflux.js` nach `%APPDATA%\Spotify\Apps\xpui\extensions\` kopieren und Spotify neu starten. Alternativ `install.ps1` ausführen.

## Installation
```powershell
powershell -ExecutionPolicy Bypass -File .install.ps1
```
Voraussetzung ist die Spicetify CLI. Falls sie fehlt, nennt das Skript den offiziellen Installationsbefehl.

## Entwicklung (Git-Repo)
- Branch `main`. Jede veröffentlichte Version bekommt einen Tag `vX.Y`, die Versionsnummer steht oben in `src/coverflux.js`.
- Ablauf: Änderung in `src/` vornehmen, im Harness testen, nach Spotify kopieren, committen und taggen.
- Der Ordner `backup/` ist nur noch eine lokale Altlast und wird von Git ignoriert.

## Dateien
- `src/coverflux.js`: die Extension (eine Datei, ohne Build)
- `test/harness.html`: Test mit nachgebautem Spicetify und Spotify-Layout. Starten mit `npx http-server -p 8765 .` und dann `http://localhost:8765/test/harness.html` öffnen. Mit `?noanalysis` testest du den Fallback.
- Debug in den Spotify DevTools: `Coverflux.open()`, `Coverflux.state`
