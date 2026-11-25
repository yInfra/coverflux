# Coverflux

**Album art, folded to the beat.** Coverflux turns the cover of whatever is playing into a beat-locked visualizer. It folds the cover through kaleidoscopes, hyperbolic tilings, Droste spirals and circle inversions. Every effect is a closed loop that always lands back exactly on the original artwork, and the calmer the music, the more of the original stays visible.

**[▶ Try it in your browser](https://yinfra.github.io/coverflux/)**: play an audio file, or let it follow a browser tab or your microphone. It runs on desktop and mobile and uploads nothing.

| Full screen | Square |
| --- | --- |
| ![Kaleido, full screen](docs/preview-kaleido.png) | ![Square with a glowing blurred mirror](docs/preview-square.png) |

<sub>Previews use generated test covers.</sub>

[Deutsch](README.de.md)

## Two ways to use it

### In the browser (any platform)
Open **[yinfra.github.io/coverflux](https://yinfra.github.io/coverflux/)** and pick a source:

| Source | How the beat is found |
| --- | --- |
| **Play a file** (MP3, FLAC, WAV, OGG …, drag & drop works) | Exact offline analysis of the whole song. Title, artist and cover come from the file's tags. |
| **Tab or system audio**, e.g. Spotify in the browser | Live beat tracking on the shared audio. Tick *Share audio* when you share. |
| **Microphone**, music in the room | Live beat tracking |

You can drop in your own image as the cover at any time.

### Spotify Desktop
On Windows, macOS and Linux, Coverflux runs as a [Spicetify](https://spicetify.app) extension. A button next to the lyrics button turns everything above the playbar into the visualizer, and a soft reflection of it glows in the playbar.

Install it from the Spicetify Marketplace, or by hand:

```bash
git clone https://github.com/yInfra/coverflux.git && cd coverflux
sh ./install.sh                                            # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\install.ps1      # Windows
```

To install manually, copy [`dist/coverflux.js`](dist/coverflux.js) into Spicetify's `Extensions` folder, then run `spicetify config extensions coverflux.js` and `spicetify apply`. Run `spicetify backup apply` again after every Spotify update.

On Spotify Desktop, Coverflux uses Spotify's audio analysis. It checks and corrects that analysis, and it can analyse your own files (see below), which also gives local files a real beat.

## Modes

Songs are split into cycles of about 16 bars, aligned to the song's sections. At every cycle boundary you see the untouched original. *Auto* switches modes only there, so the switch itself is never visible, and it picks calm or energetic modes to match the music. In the mode list, a tick puts a mode into Auto's rotation, and clicking a row plays only that mode.

| Group | Mode | Mathematics |
| --- | --- | --- |
| Flow | Liquid · Ripple · Vortex · Prism · Tunnel | domain warping, refraction, radially delayed rotation, Droste zoom |
| Symmetry | Kaleido · Mandala · Hexa · Rosette · Moiré · Quasicrystal | dihedral groups, wallpaper group p6m, z ↦ zⁿ, interfering lattices, n-fold plane waves |
| Fractal | Fractal · Sierpinski · Inversion · Phyllotaxis | box folds, IFS, Apollonian circle inversion, golden-angle cells |
| Space | Escher spiral · Hyperbolic · Triangle group · Sphere · Möbius flow | conformal Droste twist, {7,3} Poincaré disk, (P,4) Schwarz triangles, icosahedral group, loxodromic Möbius map |

Every point travels on its own closed path that only moves forward. The motion glides steadily and surges on each beat. With `prefers-reduced-motion`, rotations stop and the amplitude drops.

## Beat detection

Coverflux has its own beat tracker in plain JavaScript. It needs no dependencies, runs in a Web Worker, and works the same in the browser, in Spotify and in Node.

- **Offline**, for files:
  - log-band spectrogram, then spectral flux (SuperFlux-style)
  - tempo from the whole metrical family of the autocorrelation
  - dynamic-programming beat tracking (Ellis 2007) with sub-frame refinement
  - downbeats from harmony changes and bass hits, duple or triple meter
  - steady extrapolation through beatless intros and outros
- **Live**, for tab, system and microphone audio:
  - a rolling 16 s window, re-estimated every 0.5 s
  - a PI phase-locked loop keeps the grid smooth, and committed beats never move
  - two estimates run side by side, one tracking the current tempo and one free. The grid only switches when the free one clearly explains the music better, which gets it out of a wrong lock on an intro.
- **Felt tempo:** The felt pulse stays at or below 140 BPM. Faster songs play on beats 1 and 3, and triple meter is never halved.
- **Matching your files to Spotify:** Analyses of your files are matched to Spotify's streams by onsets, chroma and loudness, so downloads with a different intro still line up.
- **Accuracy:** Measured against the neural reference [Beat This!](https://github.com/CPJKU/beat_this) on two pop/hip-hop songs, the offline tracker hits 97–100 % of the beats in the groove and the live tracker 80–84 %.

In the Tempo panel, a dot blinks on every felt beat. If a song is off anyway, *Tap* (or `T`) sets the tempo and beat position for that song, and `[` / `]` shift everything by 10 ms.

## Privacy

Everything runs locally. Audio, files and analyses never leave the device. Analyses and settings are stored in the browser's (or Spotify's) local storage.

## Development

```text
src/beat-engine.js      beat tracking: offline analysis, live tracking, alignment
src/core.js             the visualizer: WebGL2 renderer, 20 shader modes, beat clock, UI – talks to a host interface
src/adapters/           spicetify.js (Spotify Desktop), web.js (browser)
dist/coverflux.js       Spicetify bundle   ┐ built by `npm run build`, committed,
web/coverflux-web.js    web bundle         ┘ CI checks they are current
test/                   harness (mocked Spicetify), engine tests on synthetic drums, grid tests
tools/                  build, mode contact sheet, UI screenshots, beat evaluation
```

```bash
npm install          # Playwright for tests and screenshots
npm test             # syntax checks + all tests (headless)
npm run build        # rebuild the bundles after changing src/
npm run serve        # http://localhost:8765/web/ and /test/harness.html
npm run modes        # contact sheet of every mode across its cycle (needs local Chrome with GPU)
```

New platforms only need a host adapter. See the interface at the top of [`src/core.js`](src/core.js).

## License

[MIT](LICENSE) © yInfra. Coverflux is not affiliated with Spotify. Cover art shown belongs to its respective owners and is only ever displayed locally.
