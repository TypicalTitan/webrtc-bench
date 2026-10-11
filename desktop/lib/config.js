const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Small JSON store in the app's userData folder: desktop identity, pairing tokens
 * (encrypted with the OS keystore when available) and the last-used settings.
 */
class Config {
  constructor(file, safeStorage) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.data = { desktopId: null, desktopName: os.hostname(), paired: {}, settings: {}, customVideos: [] };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run
    }
    if (!this.data.desktopId) {
      this.data.desktopId = crypto.randomUUID();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _seal(token) {
    if (this.safeStorage?.isEncryptionAvailable()) {
      return { enc: this.safeStorage.encryptString(token).toString('base64') };
    }
    return { plain: token };
  }

  _open(sealed) {
    if (!sealed) return null;
    if (sealed.enc && this.safeStorage?.isEncryptionAvailable()) {
      try {
        return this.safeStorage.decryptString(Buffer.from(sealed.enc, 'base64'));
      } catch {
        return null;
      }
    }
    return sealed.plain ?? null;
  }

  getPairing(tvId) {
    const p = this.data.paired[tvId];
    if (!p) return null;
    return { tvId, name: p.name, model: p.model, lastIp: p.lastIp, pairedAt: p.pairedAt, token: this._open(p.token) };
  }

  listPairings() {
    return Object.keys(this.data.paired).map((id) => {
      const { token, ...rest } = this.getPairing(id);
      return { ...rest, hasToken: !!token };
    });
  }

  savePairing(tvId, { name, model, lastIp, token }) {
    const prev = this.data.paired[tvId] || {};
    this.data.paired[tvId] = {
      name: name ?? prev.name,
      model: model ?? prev.model,
      lastIp: lastIp ?? prev.lastIp,
      pairedAt: prev.pairedAt || Date.now(),
      token: token ? this._seal(token) : prev.token,
    };
    this.save();
  }

  removePairing(tvId) {
    delete this.data.paired[tvId];
    this.save();
  }

  getSettings() {
    return this.data.settings || {};
  }

  setSettings(patch) {
    this.data.settings = { ...this.getSettings(), ...patch };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Config };
