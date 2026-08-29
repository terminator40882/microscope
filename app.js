const video = document.querySelector('#cameraVideo');
const canvas = document.querySelector('#previewCanvas');
const context = canvas.getContext('2d', { alpha: false });
const startButton = document.querySelector('#startButton');
const installButton = document.querySelector('#installButton');
const menuButton = document.querySelector('#menuButton');
const menu = document.querySelector('#menu');
const captureButton = document.querySelector('#captureButton');
const cameraSelect = document.querySelector('#cameraSelect');
const zoomRange = document.querySelector('#zoomRange');
const zoomValue = document.querySelector('#zoomValue');
const focusMode = document.querySelector('#focusMode');
const focusDistanceRow = document.querySelector('#focusDistanceRow');
const focusRange = document.querySelector('#focusRange');
const focusValue = document.querySelector('#focusValue');
const toast = document.querySelector('#toast');

const MAX_ZOOM = 8;
const DOUBLE_TAP_MS = 320;
const TAP_SLOP = 24;
/* Ein Zug über die halbe Bildhöhe verdoppelt bzw. halbiert den Zoom. */
const ZOOM_TRAVEL = 0.5;
/* Ein Zug über die volle Bildhöhe durchfährt den ganzen Fokusbereich. */
const FOCUS_TRAVEL = 1;

const installed = matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches;

let stream;
let track;
let animationFrame;
let zoom = 1;
let cameraReady = false;
let installPrompt;
let focusCaps = { modes: [], range: undefined };
let pendingFocus;
let focusBusy = false;
let gesture;
let lastTap = { time: 0, x: 0, y: 0 };
let pinchStartDistance = 0;
let pinchStartZoom = 1;

const showToast = (message) => {
  toast.value = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2000);
};

const setMenuOpen = (open) => {
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
};

/* Im Browser bleibt der Installations-Button das einzige Bedienelement,
   solange das Installieren möglich ist. */
function updateControls() {
  const offerInstall = !installed && Boolean(installPrompt);
  installButton.hidden = !offerInstall;
  startButton.hidden = cameraReady || offerInstall;
  menuButton.hidden = !cameraReady || offerInstall;
  captureButton.hidden = !cameraReady || offerInstall;
  if (offerInstall) setMenuOpen(false);
}

function setZoom(value) {
  zoom = Math.max(1, Math.min(MAX_ZOOM, Number(value) || 1));
  zoomRange.value = String(zoom);
  zoomValue.textContent = `${zoom.toFixed(1).replace('.', ',')}×`;
}

/* Standard: die Kamera, die eine "4" im Namen trägt (z. B. "camera2 0, facing back 4x"). */
function pickDefaultCamera(cameras) {
  const rear = cameras.filter(({ label }) => !/front|user|facetime|vorder/i.test(label));
  const pool = rear.length ? rear : cameras;
  return pool.find(({ label }) => /4/.test(label)) ?? pool[0];
}

async function listCameras(activeId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(({ kind }) => kind === 'videoinput');
  cameraSelect.replaceChildren(...cameras.map((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Kamera ${index + 1}`;
    option.selected = camera.deviceId === activeId;
    return option;
  }));
  cameraSelect.disabled = cameras.length < 2;
  return cameras;
}

function buildFocusControls() {
  const capabilities = track?.getCapabilities?.() ?? {};
  const settings = track?.getSettings?.() ?? {};
  const labels = { continuous: 'Automatisch', 'single-shot': 'Einmalig', manual: 'Manuell' };
  const modes = (capabilities.focusMode ?? []).filter((mode) => mode in labels);
  focusCaps = { modes, range: capabilities.focusDistance };

  focusMode.replaceChildren(...modes.map((mode) => {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = labels[mode];
    option.selected = mode === settings.focusMode;
    return option;
  }));
  focusMode.disabled = modes.length < 2;
  if (!modes.length) {
    const option = document.createElement('option');
    option.textContent = 'Nicht steuerbar';
    focusMode.replaceChildren(option);
  }

  const range = capabilities.focusDistance;
  focusDistanceRow.hidden = !range || !modes.includes('manual');
  if (!focusDistanceRow.hidden) {
    focusRange.min = range.min;
    focusRange.max = range.max;
    focusRange.step = range.step || (range.max - range.min) / 100;
    focusRange.value = settings.focusDistance ?? range.min;
    updateFocusLabel();
  }
}

const manualFocusAvailable = () => focusCaps.modes.includes('manual') && Boolean(focusCaps.range);

function updateFocusLabel() {
  const value = Number(focusRange.value);
  const span = Number(focusRange.max) - Number(focusRange.min);
  const nearness = span ? 1 - (value - Number(focusRange.min)) / span : 1;
  focusValue.textContent = `${Math.round(nearness * 100)} % nah`;
}

function setFocusDistance(value) {
  const { min, max } = focusCaps.range;
  const clamped = Math.max(min, Math.min(max, value));
  focusRange.value = String(clamped);
  focusDistanceRow.hidden = false;
  focusMode.value = 'manual';
  updateFocusLabel();
  queueFocus(clamped);
  return clamped;
}

async function applyFocus(mode, distance) {
  if (!track?.applyConstraints) return false;
  const constraint = { focusMode: mode };
  if (mode === 'manual' && Number.isFinite(distance)) constraint.focusDistance = distance;
  try {
    await track.applyConstraints({ advanced: [constraint] });
    return true;
  } catch {
    return false;
  }
}

/* Während einer Geste laufen sonst zu viele applyConstraints-Aufrufe parallel. */
async function queueFocus(distance) {
  pendingFocus = distance;
  if (focusBusy) return;
  focusBusy = true;
  while (pendingFocus !== undefined) {
    const value = pendingFocus;
    pendingFocus = undefined;
    await applyFocus('manual', value);
  }
  focusBusy = false;
}

/* Bevorzugt den nächstmöglichen Fokus – die App ist eine Lupe. */
async function applyClosestFocus() {
  const capabilities = track?.getCapabilities?.() ?? {};
  const modes = capabilities.focusMode ?? [];
  const range = capabilities.focusDistance;
  if (modes.includes('manual') && range && Number.isFinite(range.min)) {
    if (await applyFocus('manual', range.min)) return;
  }
  if (modes.includes('continuous')) await applyFocus('continuous');
}

async function startCamera(deviceId, { autoSelect = false } = {}) {
  cancelAnimationFrame(animationFrame);
  stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
  const resolution = { width: { ideal: 3840 }, height: { ideal: 2160 } };
  const constraint = deviceId
    ? { deviceId: { exact: deviceId }, ...resolution }
    : { facingMode: { ideal: 'environment' }, ...resolution };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraint });
    video.srcObject = stream;
    await video.play();
    track = stream.getVideoTracks()[0];

    const cameras = await listCameras(track.getSettings().deviceId);
    if (autoSelect) {
      const preferred = pickDefaultCamera(cameras);
      if (preferred?.deviceId && preferred.deviceId !== track.getSettings().deviceId) {
        return startCamera(preferred.deviceId);
      }
    }

    await applyClosestFocus();
    buildFocusControls();
    cameraReady = true;
    zoomRange.disabled = false;
    updateControls();
    drawPreview();
  } catch (error) {
    cameraReady = false;
    updateControls();
    showToast(error.name === 'NotAllowedError' ? 'Kamerazugriff verweigert' : 'Kamera nicht verfügbar');
  }
}

function drawPreview() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const targetWidth = Math.round(canvas.clientWidth * dpr);
  const targetHeight = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  if (video.videoWidth) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, targetWidth, targetHeight);
    const fitScale = Math.min(targetWidth / video.videoWidth, targetHeight / video.videoHeight);
    const drawnWidth = video.videoWidth * fitScale * zoom;
    const drawnHeight = video.videoHeight * fitScale * zoom;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(video, (targetWidth - drawnWidth) / 2, (targetHeight - drawnHeight) / 2, drawnWidth, drawnHeight);
  }
  animationFrame = requestAnimationFrame(drawPreview);
}

function capturePhoto() {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `mikroskop-${new Date().toISOString().replaceAll(':', '-')}.jpg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    captureButton.classList.add('flash');
    setTimeout(() => captureButton.classList.remove('flash'), 140);
  }, 'image/jpeg', 0.95);
}

startButton.addEventListener('click', () => startCamera(undefined, { autoSelect: true }));
menuButton.addEventListener('click', () => setMenuOpen(menu.hidden));
captureButton.addEventListener('click', capturePhoto);
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));
zoomRange.addEventListener('input', () => setZoom(zoomRange.value));
focusMode.addEventListener('change', async () => {
  focusDistanceRow.hidden = focusMode.value !== 'manual' || !focusCaps.range;
  if (!await applyFocus(focusMode.value, Number(focusRange.value))) showToast('Fokusmodus nicht möglich');
});
focusRange.addEventListener('input', () => {
  updateFocusLabel();
  queueFocus(Number(focusRange.value));
});

/* Gesten auf der Vorschau:
   – ein Finger hoch/runter: Zoom (runter = ran)
   – Doppeltipp, zweiter Finger bleibt liegen und zieht hoch/runter: Fokus
     (runter = weiter weg)
   – zwei Finger: klassisches Pinch-Zoom */
canvas.addEventListener('touchstart', (event) => {
  setMenuOpen(false);
  if (event.touches.length === 2) {
    gesture = undefined;
    pinchStartDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    pinchStartZoom = zoom;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  const isSecondTap = performance.now() - lastTap.time < DOUBLE_TAP_MS
    && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < TAP_SLOP * 2;
  const focusGesture = isSecondTap && manualFocusAvailable();
  if (isSecondTap && !focusGesture) showToast('Fokus nicht steuerbar');
  gesture = {
    mode: focusGesture ? 'focus' : 'zoom',
    startX: touch.clientX,
    startY: touch.clientY,
    startZoom: zoom,
    startFocus: Number(focusRange.value),
    moved: false,
  };
}, { passive: true });

canvas.addEventListener('touchmove', (event) => {
  if (event.touches.length === 2 && pinchStartDistance) {
    const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    setZoom(pinchStartZoom * distance / pinchStartDistance);
    return;
  }
  if (event.touches.length !== 1 || !gesture) return;
  const touch = event.touches[0];
  const deltaY = touch.clientY - gesture.startY;
  if (Math.hypot(touch.clientX - gesture.startX, deltaY) > TAP_SLOP) gesture.moved = true;
  if (!gesture.moved) return;
  const travel = deltaY / Math.max(innerHeight, 1);
  if (gesture.mode === 'focus') {
    const { min, max } = focusCaps.range;
    setFocusDistance(gesture.startFocus + (travel / FOCUS_TRAVEL) * (max - min));
  } else {
    setZoom(gesture.startZoom * 2 ** (travel / ZOOM_TRAVEL));
  }
}, { passive: true });

canvas.addEventListener('touchend', (event) => {
  if (event.touches.length === 0) pinchStartDistance = 0;
  if (!gesture) return;
  const touch = event.changedTouches[0];
  /* Nur ein echter Tipp zählt für den Doppeltipp. */
  lastTap = gesture.moved
    ? { time: 0, x: 0, y: 0 }
    : { time: performance.now(), x: touch.clientX, y: touch.clientY };
  gesture = undefined;
}, { passive: true });

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') setMenuOpen(false);
});

/* Randlos: im Browser beim ersten Antippen in den Vollbildmodus wechseln. */
if (!installed) {
  document.addEventListener('pointerdown', () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, { once: true });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  updateControls();
});
installButton.addEventListener('click', async () => {
  const prompt = installPrompt;
  installPrompt = undefined;
  updateControls();
  await prompt?.prompt().catch(() => {});
});
window.addEventListener('appinstalled', () => {
  installPrompt = undefined;
  updateControls();
});
window.addEventListener('pagehide', () => stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop()));

setZoom(1);
updateControls();
/* Ohne Nachfrage starten, wenn die Berechtigung bereits erteilt ist. */
navigator.permissions?.query({ name: 'camera' })
  .then(({ state }) => { if (state === 'granted') startCamera(undefined, { autoSelect: true }); })
  .catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
