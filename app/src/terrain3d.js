// Desktop only: the terrain in 3D. Tilt and turn with the right mouse button (or Ctrl + drag, or by dragging the
// compass), zoom with the wheel, and raise the relief with a slider (x1 to x5) so steep ground and valleys read at a
// glance. Heights come from the ~30 m elevation model (the area pack's FABDEM): short steep pitches are smoothed away.
// On the topo map (or no base map) the hillshade comes on with it: nothing else shades the relief there.
import { settings, saveSettings } from './settings.js';
import { isDesktop, applyLayers } from './mapview.js';

const $ = (id) => document.getElementById(id);
let map = null;
let button = null;

export const on3d = () => !!map?.getTerrain?.();

class Button3D {
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ctrl-3d';
    button.textContent = '3D';
    button.title = '3D terrain';
    button.setAttribute('aria-label', '3D terrain');
    button.addEventListener('click', () => set3d(!on3d()));
    div.append(button);
    return div;
  }

  onRemove() {}
}

export function initTerrain3d(m) {
  map = m;
  if (!isDesktop()) return;
  map.addControl(new Button3D(), 'top-right');
  const slider = $('t3d-exag');
  slider.value = settings.terrain3d.exag;
  label();
  slider.addEventListener('input', () => {
    settings.terrain3d.exag = +slider.value;
    label();
    if (on3d()) map.setTerrain({ source: 'terrain', exaggeration: settings.terrain3d.exag });
  });
  slider.addEventListener('change', () => saveSettings());
  $('t3d-off').addEventListener('click', () => set3d(false));
}

function label() {
  const x = settings.terrain3d.exag;
  $('t3d-label').textContent = x <= 1.001 ? 'Height: real' : `Height: ×${x.toFixed(1)}`;
}

export function set3d(on, animate = true) {
  if (!map || !isDesktop()) return;
  if (on) {
    map.setMaxPitch(85);
    map.setTerrain({ source: 'terrain', exaggeration: settings.terrain3d.exag });
    if (animate) map.easeTo({ pitch: 60, duration: 900 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, duration: animate ? 600 : 0 });
    map.once('moveend', () => { if (!on3d() && !document.body.classList.contains('navigating')) map.setMaxPitch(0); });
  }
  settings.terrain3d.on = on;
  saveSettings();
  applyLayers(map);                        // the topo map gets its hillshade in 3D
  $('t3d').hidden = !on;
  button?.classList.toggle('on', on);
}
