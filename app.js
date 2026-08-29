const video = document.querySelector('#cameraVideo');
const canvas = document.querySelector('#previewCanvas');
const context = canvas.getContext('2d', { alpha: false });
const startPanel = document.querySelector('#startPanel');
const startButton = document.querySelector('#startButton');
const cameraSelect = document.querySelector('#cameraSelect');
const zoomRange = document.querySelector('#zoomRange');
const zoomValue = document.querySelector('#zoomValue');
const captureButton = document.querySelector('#captureButton');
const resetButton = document.querySelector('#resetButton');
const installButton = document.querySelector('#installButton');
const focusBadge = document.querySelector('#focusBadge');
const reticle = document.querySelector('#reticle');
const toast = document.querySelector('#toast');

let stream;
let animationFrame;
let zoom = 1;
let deferredInstallPrompt;
let pinchStartDistance = 0;
let pinchStartZoom = 1;

const showToast = (message) => {
  toast.value = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
};

function setZoom(value) {
  zoom = Math.max(1, Math.min(8, Number(value)));
  zoomRange.value = String(zoom);
  zoomValue.value = `${zoom.toFixed(1).replace('.', ',')}×`;
}

async function applyClosestFocus(track) {
  const capabilities = track.getCapabilities?.() ?? {};
  const advanced = [];
  if (capabilities.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  if (capabilities.focusDistance && Number.isFinite(capabilities.focusDistance.max)) {
    const closestFocus = { focusDistance: capabilities.focusDistance.max };
    if (capabilities.focusMode?.includes('manual')) closestFocus.focusMode = 'manual';
    advanced.push(closestFocus);
  }
  for (const constraint of advanced) {
    try {
      await track.applyConstraints({ advanced: [constraint] });
      focusBadge.textContent = constraint.focusDistance ? 'Maximaler Nahfokus' : 'Kontinuierlicher Fokus';
      focusBadge.style.color = '#b9f35b';
      return;
    } catch { /* Try the next supported focus strategy. */ }
  }
  focusBadge.textContent = 'Autofokus des Geräts';
}

async function listRearCameras(selectedId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(({ kind }) => kind === 'videoinput');
  const likelyRear = cameras.filter(({ label }) => !/front|user|facetime|vorder/i.test(label));
  const choices = likelyRear.length ? likelyRear : cameras;
  cameraSelect.replaceChildren(...choices.map((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Rückkamera ${index + 1}`;
    option.selected = camera.deviceId === selectedId;
    return option;
  }));
  cameraSelect.disabled = choices.length < 2;
}

async function startCamera(deviceId) {
  cancelAnimationFrame(animationFrame);
  stream?.getTracks().forEach((track) => track.stop());
  const videoConstraint = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    await applyClosestFocus(track);
    await listRearCameras(track.getSettings().deviceId);
    startPanel.hidden = true;
    zoomRange.disabled = false;
    captureButton.disabled = false;
    resetButton.disabled = false;
    drawPreview();
  } catch (error) {
    startPanel.hidden = false;
    startPanel.querySelector('p').textContent = error.name === 'NotAllowedError'
      ? 'Der Kamerazugriff wurde abgelehnt. Erlaube ihn in den Website-Einstellungen und versuche es erneut.'
      : 'Die Kamera konnte nicht gestartet werden. Bitte prüfe, ob sie von einer anderen App verwendet wird.';
    showToast('Kamera nicht verfügbar');
  }
}

function drawPreview() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;
  const targetWidth = Math.round(displayWidth * dpr);
  const targetHeight = Math.round(displayHeight * dpr);
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
    reticle.classList.add('visible');
    setTimeout(() => reticle.classList.remove('visible'), 180);
    showToast('Sichtbarer Ausschnitt gespeichert');
  }, 'image/jpeg', 0.95);
}

startButton.addEventListener('click', () => startCamera());
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));
zoomRange.addEventListener('input', () => setZoom(zoomRange.value));
resetButton.addEventListener('click', () => setZoom(1));
captureButton.addEventListener('click', capturePhoto);

const viewer = document.querySelector('#viewer');
viewer.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 2) return;
  pinchStartDistance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
  pinchStartZoom = zoom;
}, { passive: true });
viewer.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 2 || !pinchStartDistance) return;
  const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
  setZoom(pinchStartZoom * distance / pinchStartDistance);
}, { passive: true });

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  await deferredInstallPrompt?.prompt();
  deferredInstallPrompt = undefined;
  installButton.hidden = true;
});
window.addEventListener('appinstalled', () => showToast('App wurde installiert'));
window.addEventListener('pagehide', () => stream?.getTracks().forEach((track) => track.stop()));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
