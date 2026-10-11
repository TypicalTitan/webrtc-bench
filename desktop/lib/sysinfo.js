const os = require('os');

/** Desktop facts recorded in the report (the sender side of every test). */
async function desktopInfo(app, screen) {
  const cpus = os.cpus();
  const info = {
    host: os.hostname(),
    os: `${os.version?.() || os.type()} (${os.release()})`,
    arch: os.arch(),
    cpu: cpus[0]?.model?.trim() || 'unknown',
    cpuThreads: cpus.length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    gpus: [],
    gpuFeatures: {},
    displays: [],
  };
  try {
    const g = await app.getGPUInfo('complete');
    const devices = g.gpuDevice || [];
    info.gpus = devices.map((d) => ({
      active: !!d.active,
      vendorId: d.vendorId,
      deviceId: d.deviceId,
      name: d.deviceString || d.description || '',
      driver: d.driverVersion || '',
    }));
    const aux = g.auxAttributes || {};
    if (aux.glRenderer) info.glRenderer = aux.glRenderer;
    const vd = g.videoDecoding || g.videoDecodeAcceleratorSupportedProfile;
    const ve = g.videoEncoding || g.videoEncodeAcceleratorSupportedProfile;
    if (Array.isArray(vd)) info.hwDecodeProfiles = vd.map((p) => p.profile || p.codec).filter(Boolean);
    if (Array.isArray(ve)) info.hwEncodeProfiles = ve.map((p) => p.profile || p.codec).filter(Boolean);
  } catch {
    // GPU info is best-effort
  }
  try {
    info.gpuFeatures = app.getGPUFeatureStatus();
  } catch {
    // older Electron
  }
  try {
    info.displays = screen.getAllDisplays().map((d) => ({
      size: `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}`,
      refreshRate: d.displayFrequency,
      scale: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
  } catch {
    // headless
  }
  return info;
}

module.exports = { desktopInfo };
