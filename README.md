# FPV Channel Planner

**Live app:** <https://fl0ridaman.github.io/fpv-channel-planner/>. Open it in Chrome or Edge on Android, macOS or Windows, then choose *Install app*.

Offline-capable planner for deconflicting analog (and HDZero) FPV video channels across multiple teams. It accounts for each drone's VTX table, power, antennas and goggles, plus team positions, terrain and outside emitters.

It is a Progressive Web App (PWA), so one codebase runs on **macOS, Windows and Android**. There is no build step and no backend. All mission data stays on the device.

## Running it

**Mac / Windows (local):** from this folder run

```bash
python3 -m http.server 8765
```

then open <http://localhost:8765>. In Chrome or Edge, use *Install app* in the address bar to get a standalone window.

**Android:** open the live app link above in Chrome, then *⋮ → Install app* (or *Add to Home screen*). Installation needs HTTPS, which GitHub Pages provides. If you need a sideloadable APK later, the folder can be wrapped with Capacitor without code changes.

**Offline:** open the app once while online. Then pan the map to the mission area and use *☰ → Download map + terrain for offline…*. After that the planner, the map tiles and the terrain all work without a connection.

## User manual

The full manual is built in. Use the **?** button or *☰ → User manual* ([manual.html](manual.html)). It covers every tab, how to read results, field procedure, troubleshooting, and step-by-step VTX setup for **Betaflight, INAV and ArduPilot**.

## Workflow

The planner starts blank.

1. **Teams & Aircraft**:
   - *+ Add team* with its **launch point**: type an MGRS grid or lat/long, or pick it on the map. Set the radius, height and time window.
   - *+ Add aircraft* for each quad. Enter the callsign, **pilot name**, flight controller, goggles and VTX model.
   - **Upload the `vtxtable` pulled from that quad.**
   - Solve picks each aircraft's channel **and** its **takeoff/landing** and **in-flight** VTX power.
   - Each new aircraft copies the previous one's setup.
   - Optional: draw a **team route** (or import it from ATAK), add **pilot movement**, and give aircraft **targets**.
   - Set each aircraft to **hand-flown** or **autonomous** (INAV/ArduPilot mission downloads).
2. **Environment**: add urban noise and outside emitters (Wi-Fi, other units).
3. **Solve**: review the Plan tab.
4. **Export**: *Channel card (print)*, *Flight controller commands* (Betaflight/INAV CLI, ArduPilot `.param`, including the takeoff → flight power switch setup), and *Save mission file*.

## Model (summary)

- **Own link:** the drone sits at the edge of its team circle with line of sight, minus a fade margin (default 6 dB).
- **Interference:** every other airborne VTX is placed at its worst-case position (19 sample points in its circle), at flight power. Loss = free-space loss + Deygout knife-edge diffraction over a ~30 m DEM with 4/3-earth curvature.
- **Teammates:** checked twice, and the worse case is used: in flight at the in-flight spacing (flight power), and taking off at the takeoff spacing (takeoff power).
- **Polarization:** RHCP vs LHCP ≈ 15 dB on line of sight, 3 dB when obstructed. Circular vs linear = 3 dB.
- **Receiver:**
  - Off-channel rejection depends on frequency offset. Each VTX's frequency tolerance is subtracted first, and the extra width of a digital VTX's signal is taken into account.
  - 3rd-order intermodulation (2f₁−f₂) is checked for every pair of strong signals.
  - Margin = soft-minimum of (SIR − required SIR) and (SNR − required SNR).
- **Solver:** simulated annealing across every channel that both the VTX table and the goggle support. It maximizes the worst pilot's margin. Optionally it raises power on range-limited links and then steps power down while keeping every link at ≥ 3 dB.
- **Time windows:** teams whose windows don't overlap don't interfere, so they can share channels.

## Data sources

- Basemaps: USGS The National Map (Topo, Imagery+Topo, Shaded Relief). Public domain, US coverage.
- Terrain: AWS Open Data Terrain Tiles (Terrarium), which uses USGS 3DEP in the US. Sampled at zoom 12 (~30 m).

## Limits: read before relying on it

- These are **planning estimates**, not measurements. Always do a goggle or spectrum scan on site.
- The terrain is **bare earth**: trees and buildings are not modelled. This matters a lot in DC. Use *Extra loss when blocked* if you want to give credit for clutter.
- Receiver selectivity, noise figure and IIP3 values are generic estimates. Calibrate them from field experience.
- The DC FRZ/SFRA circles are approximate references only. Check the actual airspace and authorizations through the FAA.

## Layout

```
index.html, css/app.css, sw.js, manifest.webmanifest, icons/
js/app.js       UI
js/rf.js        propagation, selectivity, IMD, SINR
js/solver.js    channel + power optimisation
js/terrain.js   DEM tile loading and sampling
js/vtxtable.js  Betaflight vtxtable CLI/JSON parsing
js/data.js      presets, sites
js/store.js     state, example missions, persistence
js/mapview.js   Leaflet map
js/export.js    channel card, Betaflight/INAV/ArduPilot commands
js/firmware.js  INAV + ArduPilot built-in band/power tables
js/coords.js    MGRS / UTM / lat-long parsing and formatting (WGS84)
js/paths.js     routes, targets, moving pilots, sampling
js/missions.js  .waypoints / .plan / INAV .mission export, KML export + KML/KMZ import
manual.html     in-app user manual
vendor/leaflet  Leaflet 1.9.4 (bundled for offline)
```
