/* Mikroskop – Kamera-Lupe als PWA.
   Aufbau: Elemente → Einstellungen → Bühne/Ausrichtung → Kamera → Fokus →
   Rendering → Aufnahme → Gesten → Menü/Zahlen → Installation & Update. */

const $ = (selector) => document.querySelector(selector);

const video = $('#cameraVideo');
const stage = $('#stage');
const canvas = $('#previewCanvas');
const context = canvas.getContext('2d', { alpha: false });
const hud = $('#hud');
const toast = $('#toast');
const startButton = $('#startButton');
const installButton = $('#installButton');
const menuButton = $('#menuButton');
const menu = $('#menu');
const captureButton = $('#captureButton');
const resetButton = $('#resetButton');
const cameraSelect = $('#cameraSelect');
const zoomRange = $('#zoomRange');
const zoomNumber = $('#zoomNumber');
const zoomValue = $('#zoomValue');
const aspectSelect = $('#aspectSelect');
const aspectNumber = $('#aspectNumber');
const aspectValue = $('#aspectValue');
const focusModeSelect = $('#focusMode');
const focusDistanceRow = $('#focusDistanceRow');
const focusRange = $('#focusRange');
const focusNumber = $('#focusNumber');
const focusValue = $('#focusValue');
const sensYRange = $('#sensYRange');
const sensYNumber = $('#sensYNumber');
const sensXRange = $('#sensXRange');
const sensXNumber = $('#sensXNumber');
const maxZoomRange = $('#maxZoomRange');
const maxZoomNumber = $('#maxZoomNumber');
const infoResolution = $('#infoResolution');
const infoCrop = $('#infoCrop');
const infoZoomRange = $('#infoZoomRange');
const infoOrientation = $('#infoOrientation');
const infoDevice = $('#infoDevice');

/* ---------------------------------------------------------------- Einstellungen */

const STORAGE_KEY = 'mikroskop.settings';
const DEFAULTS = {
  zoom: 1,
  aspect: 1.6,          /* 16:10 */
  aspectMode: '1.6',    /* Auswahlwert, "sensor" folgt dem Kameraformat */
  sensY: 2,             /* Zoom-Verdopplungen pro Bildhöhe (negativ = umgekehrt) */
  sensX: 1,             /* Anteil des Fokusbereichs pro Bildbreite */
  maxZoom: 8,
  focusDistance: null,
};
const LIMITS = {
  zoom: [0.05, 16],
  aspect: [0.3, 4],
  sensY: [-8, 8],
  sensX: [-4, 4],
  maxZoom: [2, 16],
};

const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const de = (value, digits = 2) => value.toFixed(digits).replace('.', ',');

let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in stored)) continue;
      if (key === 'aspectMode') settings.aspectMode = String(stored.aspectMode);
      else if (key === 'focusDistance') settings.focusDistance = stored.focusDistance === null ? null : number(stored.focusDistance, null);
      else settings[key] = clamp(number(stored[key], DEFAULTS[key]), LIMITS[key] ?? [-Infinity, Infinity]);
    }
  } catch { /* Kaputte oder gesperrte Ablage: Standardwerte behalten. */ }
}

function saveSettings() {
  clearTimeout(saveSettings.timer);
  saveSettings.timer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* Privater Modus: nicht speicherbar, egal. */ }
  }, 250);
}

/* ---------------------------------------------------------------- Zustand */

let stream;
let track;
let animationFrame;
let cameraReady = false;
let installPrompt;
let focusCaps = { modes: [], range: undefined };
let pendingFocus;
let focusBusy = false;
let visibleRect = { x: 0, y: 0, width: 0, height: 0 };
let gesture;
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let uiRotation = 0;

const installed = matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches;

const showToast = (message) => {
  toast.value = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2000);
};

function showHud() {
  const lines = [`${de(settings.zoom, 2)}×`];
  if (manualFocusAvailable()) lines.push(`${de(Number(focusRange.value), 2)} m`);
  hud.value = lines.join('\n');
  hud.classList.add('show');
  clearTimeout(showHud.timer);
  showHud.timer = setTimeout(() => hud.classList.remove('show'), 1200);
}

const setMenuOpen = (open) => {
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  if (open) updateReadout();
};

/* ---------------------------------------------------------------- Bühne / Ausrichtung */

/* Die App ist quer gedacht. Lässt sich die Ausrichtung nicht sperren, wird die
   Bühne selbst gedreht – und die Wischrichtungen wandern mit. */
function updateStage() {
  const portrait = innerHeight > innerWidth;
  stage.classList.toggle('rotated', portrait);
  uiRotation = portrait ? 90 : 0;
  infoOrientation.textContent = portrait ? 'hochkant → gedreht' : 'quer';
}

function lockLandscape() {
  screen.orientation?.lock?.('landscape').catch(() => { /* Nicht überall erlaubt. */ });
}

/* Bildschirm-Delta in Bühnenkoordinaten: bei gedrehter Bühne tauschen die Achsen. */
const toStage = (dx, dy) => (uiRotation === 90 ? { x: dy, y: -dx } : { x: dx, y: dy });

addEventListener('resize', updateStage);
addEventListener('orientationchange', updateStage);

/* ---------------------------------------------------------------- Kamera */

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
  infoDevice.textContent = cameras.find(({ deviceId }) => deviceId === activeId)?.label || '–';
  return cameras;
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

    buildFocusControls();
    await restoreFocus();
    cameraReady = true;
    updateControls();
    setZoom(settings.zoom);
    drawPreview();
  } catch (error) {
    cameraReady = false;
    updateControls();
    showToast(error.name === 'NotAllowedError' ? 'Kamerazugriff verweigert' : 'Kamera nicht verfügbar');
  }
}

/* ---------------------------------------------------------------- Fokus */

const manualFocusAvailable = () => focusCaps.modes.includes('manual') && Boolean(focusCaps.range);

function buildFocusControls() {
  const capabilities = track?.getCapabilities?.() ?? {};
  const trackSettings = track?.getSettings?.() ?? {};
  const labels = { continuous: 'Automatisch', 'single-shot': 'Einmalig', manual: 'Manuell' };
  const modes = (capabilities.focusMode ?? []).filter((mode) => mode in labels);
  focusCaps = { modes, range: capabilities.focusDistance };

  focusModeSelect.replaceChildren(...modes.map((mode) => {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = labels[mode];
    option.selected = mode === trackSettings.focusMode;
    return option;
  }));
  focusModeSelect.disabled = modes.length < 2;
  if (!modes.length) {
    const option = document.createElement('option');
    option.textContent = 'Nicht steuerbar';
    focusModeSelect.replaceChildren(option);
  }

  focusDistanceRow.hidden = !manualFocusAvailable();
  if (manualFocusAvailable()) {
    const { min, max, step } = focusCaps.range;
    for (const input of [focusRange, focusNumber]) {
      input.min = min;
      input.max = max;
      input.step = step || (max - min) / 100 || 0.01;
    }
    setFocusDistance(settings.focusDistance ?? trackSettings.focusDistance ?? min, { apply: false });
  }
}

/* Die App ist eine Lupe: ohne gespeicherten Wert wird der nächstmögliche Fokus gesetzt. */
async function restoreFocus() {
  if (manualFocusAvailable()) {
    const target = settings.focusDistance ?? focusCaps.range.min;
    if (await applyFocus('manual', target)) {
      setFocusDistance(target, { apply: false });
      focusModeSelect.value = 'manual';
      return;
    }
  }
  if (focusCaps.modes.includes('continuous')) await applyFocus('continuous');
}

function setFocusDistance(value, { apply = true } = {}) {
  if (!manualFocusAvailable()) return;
  const { min, max } = focusCaps.range;
  const clamped = clamp(value, [min, max]);
  focusRange.value = String(clamped);
  focusNumber.value = clamped.toFixed(2);
  const span = max - min;
  focusValue.textContent = `${Math.round((span ? 1 - (clamped - min) / span : 1) * 100)} % nah`;
  settings.focusDistance = clamped;
  saveSettings();
  if (apply) {
    focusModeSelect.value = 'manual';
    focusDistanceRow.hidden = false;
    queueFocus(clamped);
  }
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

/* ---------------------------------------------------------------- Rendering */

/* Zoom 1 zeigt genau den eingestellten Bildausschnitt (Default 16:10).
   Darunter wird das Kamerabild komplett unbeschnitten sichtbar, darüber
   füllt es irgendwann den ganzen Bildschirm. */
function metrics() {
  const canvasWidth = canvas.width || 1;
  const canvasHeight = canvas.height || 1;
  const videoWidth = video.videoWidth || canvasWidth;
  const videoHeight = video.videoHeight || canvasHeight;
  const aspect = settings.aspectMode === 'sensor' ? videoWidth / videoHeight : settings.aspect;
  /* Bildfenster: größtes Rechteck im gewünschten Format, das auf den Schirm passt. */
  const frameWidth = Math.min(canvasWidth, canvasHeight * aspect);
  const frameHeight = frameWidth / aspect;
  const fitX = frameWidth / videoWidth;
  const fitY = frameHeight / videoHeight;
  return {
    aspect,
    frameWidth,
    frameHeight,
    frameScale: Math.max(fitX, fitY),          /* Zoom 1: Bild deckt das Fenster ab */
    minZoom: Math.min(fitX, fitY) / Math.max(fitX, fitY), /* ganzes Bild im Fenster */
    fullZoom: Math.max(canvasWidth / frameWidth, canvasHeight / frameHeight), /* Fenster füllt den Schirm */
    canvasWidth,
    canvasHeight,
    videoWidth,
    videoHeight,
  };
}

function setZoom(value, { save = true } = {}) {
  const { minZoom } = metrics();
  const low = Math.max(LIMITS.zoom[0], minZoom);
  settings.zoom = clamp(number(value, 1), [low, settings.maxZoom]);
  zoomRange.min = low.toFixed(3);
  zoomRange.max = settings.maxZoom.toFixed(2);
  zoomRange.value = String(settings.zoom);
  zoomNumber.value = settings.zoom.toFixed(2);
  zoomValue.textContent = `${de(settings.zoom, 3)}×`;
  if (save) saveSettings();
}

function drawPreview() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const targetWidth = Math.round(canvas.clientWidth * dpr);
  const targetHeight = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    setZoom(settings.zoom, { save: false });
  }
  if (video.videoWidth) {
    const { frameScale, frameWidth, frameHeight, videoWidth, videoHeight } = metrics();
    const scale = frameScale * settings.zoom;
    const drawnWidth = videoWidth * scale;
    const drawnHeight = videoHeight * scale;
    const left = (targetWidth - drawnWidth) / 2;
    const top = (targetHeight - drawnHeight) / 2;
    /* Das Bildfenster wächst ab Zoom 1 mit, bis es den ganzen Schirm füllt. */
    const windowWidth = Math.min(targetWidth, frameWidth * Math.max(settings.zoom, 1));
    const windowHeight = Math.min(targetHeight, frameHeight * Math.max(settings.zoom, 1));
    const windowLeft = (targetWidth - windowWidth) / 2;
    const windowTop = (targetHeight - windowHeight) / 2;
    context.fillStyle = '#000';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.save();
    context.beginPath();
    context.rect(windowLeft, windowTop, windowWidth, windowHeight);
    context.clip();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(video, left, top, drawnWidth, drawnHeight);
    context.restore();
    const x = Math.max(windowLeft, left);
    const y = Math.max(windowTop, top);
    visibleRect = {
      x,
      y,
      width: Math.min(windowLeft + windowWidth, left + drawnWidth) - x,
      height: Math.min(windowTop + windowHeight, top + drawnHeight) - y,
    };
  }
  animationFrame = requestAnimationFrame(drawPreview);
}

/* ---------------------------------------------------------------- Aufnahme */

function capturePhoto() {
  const { width, height } = visibleRect;
  if (width < 1 || height < 1) return;
  /* Nur die tatsächlich sichtbare Bildfläche speichern – ohne schwarze Ränder. */
  const output = document.createElement('canvas');
  output.width = Math.round(width);
  output.height = Math.round(height);
  output.getContext('2d').drawImage(canvas, visibleRect.x, visibleRect.y, width, height, 0, 0, output.width, output.height);
  output.toBlob((blob) => {
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

/* ---------------------------------------------------------------- Gesten */

const AXIS_LOCK = 12;

canvas.addEventListener('touchstart', (event) => {
  setMenuOpen(false);
  if (event.touches.length === 2) {
    gesture = undefined;
    pinchStartDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    pinchStartZoom = settings.zoom;
    return;
  }
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  gesture = {
    startX: touch.clientX,
    startY: touch.clientY,
    startZoom: settings.zoom,
    startFocus: Number(focusRange.value),
    axis: undefined,
  };
}, { passive: true });

canvas.addEventListener('touchmove', (event) => {
  if (event.touches.length === 2 && pinchStartDistance) {
    const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    setZoom(pinchStartZoom * distance / pinchStartDistance);
    showHud();
    return;
  }
  if (event.touches.length !== 1 || !gesture) return;
  const touch = event.touches[0];
  const delta = toStage(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
  if (!gesture.axis) {
    if (Math.hypot(delta.x, delta.y) < AXIS_LOCK) return;
    gesture.axis = Math.abs(delta.x) > Math.abs(delta.y) ? 'x' : 'y';
    if (gesture.axis === 'x' && !manualFocusAvailable()) showToast('Fokus nicht steuerbar');
  }
  if (gesture.axis === 'y') {
    /* Nach unten heißt ran. */
    setZoom(gesture.startZoom * 2 ** (delta.y / stage.clientHeight * settings.sensY));
  } else if (manualFocusAvailable()) {
    /* Nach rechts heißt weiter weg. */
    const { min, max } = focusCaps.range;
    setFocusDistance(gesture.startFocus + (delta.x / stage.clientWidth) * (max - min) * settings.sensX);
  }
  showHud();
}, { passive: true });

canvas.addEventListener('touchend', (event) => {
  if (event.touches.length === 0) pinchStartDistance = 0;
  gesture = undefined;
}, { passive: true });

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') setMenuOpen(false);
});

/* ---------------------------------------------------------------- Menü & Zahlen */

/* Regler und Zahlenfeld zeigen denselben Wert und setzen denselben Zustand. */
function linkPair(range, input, apply) {
  const handler = (event) => {
    const value = apply(Number(event.target.value));
    if (Number.isFinite(value)) {
      range.value = String(value);
      input.value = value.toFixed(2);
    }
  };
  range.addEventListener('input', handler);
  input.addEventListener('change', handler);
}

function syncSettingsInputs() {
  sensYRange.value = String(settings.sensY);
  sensYNumber.value = settings.sensY.toFixed(2);
  sensXRange.value = String(settings.sensX);
  sensXNumber.value = settings.sensX.toFixed(2);
  maxZoomRange.value = String(settings.maxZoom);
  maxZoomNumber.value = settings.maxZoom.toFixed(2);
  aspectSelect.value = settings.aspectMode;
  aspectNumber.value = settings.aspect.toFixed(3);
  aspectNumber.disabled = settings.aspectMode === 'sensor';
  aspectValue.textContent = settings.aspectMode === 'sensor' ? 'Sensor' : de(settings.aspect, 3);
}

function updateReadout() {
  const { minZoom, fullZoom, videoWidth, videoHeight } = metrics();
  infoResolution.textContent = video.videoWidth ? `${videoWidth}×${videoHeight}` : '–';
  infoCrop.textContent = visibleRect.width ? `${Math.round(visibleRect.width)}×${Math.round(visibleRect.height)}` : '–';
  infoZoomRange.textContent = `${de(minZoom, 2)} / ${de(fullZoom, 2)}`;
}

menuButton.addEventListener('click', () => setMenuOpen(menu.hidden));
captureButton.addEventListener('click', capturePhoto);
startButton.addEventListener('click', () => {
  lockLandscape();
  startCamera(undefined, { autoSelect: true });
});
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));

linkPair(zoomRange, zoomNumber, (value) => {
  setZoom(value);
  showHud();
  return settings.zoom;
});
linkPair(focusRange, focusNumber, (value) => {
  setFocusDistance(value);
  showHud();
  return Number(focusRange.value);
});
linkPair(sensYRange, sensYNumber, (value) => {
  settings.sensY = clamp(number(value, DEFAULTS.sensY), LIMITS.sensY);
  saveSettings();
  return settings.sensY;
});
linkPair(sensXRange, sensXNumber, (value) => {
  settings.sensX = clamp(number(value, DEFAULTS.sensX), LIMITS.sensX);
  saveSettings();
  return settings.sensX;
});
linkPair(maxZoomRange, maxZoomNumber, (value) => {
  settings.maxZoom = clamp(number(value, DEFAULTS.maxZoom), LIMITS.maxZoom);
  setZoom(settings.zoom);
  saveSettings();
  return settings.maxZoom;
});

aspectSelect.addEventListener('change', () => {
  settings.aspectMode = aspectSelect.value;
  if (settings.aspectMode !== 'sensor') settings.aspect = clamp(number(aspectSelect.value, DEFAULTS.aspect), LIMITS.aspect);
  syncSettingsInputs();
  setZoom(settings.zoom);
  updateReadout();
  saveSettings();
});
aspectNumber.addEventListener('change', () => {
  settings.aspect = clamp(number(aspectNumber.value, DEFAULTS.aspect), LIMITS.aspect);
  settings.aspectMode = String(settings.aspect);
  aspectSelect.value = settings.aspectMode;
  syncSettingsInputs();
  setZoom(settings.zoom);
  updateReadout();
  saveSettings();
});

focusModeSelect.addEventListener('change', async () => {
  focusDistanceRow.hidden = focusModeSelect.value !== 'manual' || !manualFocusAvailable();
  if (!await applyFocus(focusModeSelect.value, Number(focusRange.value))) showToast('Fokusmodus nicht möglich');
});

resetButton.addEventListener('click', () => {
  settings = { ...DEFAULTS };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* egal */ }
  syncSettingsInputs();
  setZoom(DEFAULTS.zoom);
  if (manualFocusAvailable()) setFocusDistance(focusCaps.range.min);
  updateReadout();
  showToast('Standardwerte');
});

/* ---------------------------------------------------------------- Installation */

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

addEventListener('beforeinstallprompt', (event) => {
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
addEventListener('appinstalled', () => {
  installPrompt = undefined;
  updateControls();
});

/* Randlos: im Browser beim ersten Antippen in den Vollbildmodus wechseln. */
if (!installed) {
  document.addEventListener('pointerdown', async () => {
    await document.documentElement.requestFullscreen?.().catch(() => {});
    lockLandscape();
  }, { once: true });
}

addEventListener('pagehide', () => stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop()));

/* ---------------------------------------------------------------- Start & Update */

loadSettings();
updateStage();
syncSettingsInputs();
setZoom(settings.zoom, { save: false });
updateControls();
lockLandscape();

/* Ohne Nachfrage starten, wenn die Berechtigung bereits erteilt ist. */
navigator.permissions?.query({ name: 'camera' })
  .then(({ state }) => { if (state === 'granted') startCamera(undefined, { autoSelect: true }); })
  .catch(() => {});

/* Beim Öffnen als PWA auf eine neue Version prüfen und automatisch übernehmen. */
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./service-worker.js').then((registration) => {
    registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  }).catch(() => {});
}
