const video = document.querySelector('#cameraVideo');
const canvas = document.querySelector('#previewCanvas');
const context = canvas.getContext('2d', { alpha: false });
const startButton = document.querySelector('#startButton');
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

let stream;
let track;
let animationFrame;
let zoom = 1;
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

function updateFocusLabel() {
  const value = Number(focusRange.value);
  const span = Number(focusRange.max) - Number(focusRange.min);
  const nearness = span ? 1 - (value - Number(focusRange.min)) / span : 1;
  focusValue.textContent = `${Math.round(nearness * 100)} % nah`;
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
    startButton.hidden = true;
    menuButton.hidden = false;
    captureButton.hidden = false;
    zoomRange.disabled = false;
    drawPreview();
  } catch (error) {
    startButton.hidden = false;
    menuButton.hidden = true;
    captureButton.hidden = true;
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
  focusDistanceRow.hidden = focusMode.value !== 'manual' || !track?.getCapabilities?.().focusDistance;
  if (!await applyFocus(focusMode.value, Number(focusRange.value))) showToast('Fokusmodus nicht möglich');
});
focusRange.addEventListener('input', () => {
  updateFocusLabel();
  applyFocus('manual', Number(focusRange.value));
});

/* Tippen neben dem Menü schließt es wieder. */
canvas.addEventListener('pointerdown', () => setMenuOpen(false));

canvas.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 2) return;
  pinchStartDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
  pinchStartZoom = zoom;
}, { passive: true });
canvas.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 2 || !pinchStartDistance) return;
  const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
  setZoom(pinchStartZoom * distance / pinchStartDistance);
}, { passive: true });

/* Randlos: im Browser beim ersten Antippen in den Vollbildmodus wechseln. */
const standalone = matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches;
if (!standalone) {
  document.addEventListener('pointerdown', () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, { once: true });
}

window.addEventListener('beforeinstallprompt', (event) => event.preventDefault());
window.addEventListener('pagehide', () => stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop()));

setZoom(1);
/* Ohne Nachfrage starten, wenn die Berechtigung bereits erteilt ist. */
navigator.permissions?.query({ name: 'camera' })
  .then(({ state }) => { if (state === 'granted') startCamera(undefined, { autoSelect: true }); })
  .catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
