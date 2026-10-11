function payloadTypes(lines, codec) {
  const pts = new Set();
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l);
    if (m && m[2].toUpperCase() === codec.toUpperCase()) pts.add(m[1]);
  }
  return pts;
}

/**
 * Adds Chrome's x-google-{start,min,max}-bitrate hints to the codec's fmtp lines so the
 * bandwidth estimator starts near the target instead of ramping up from 300 kbps.
 */
export function setBitrateHints(sdp, codec, kbps) {
  const lines = sdp.split('\r\n');
  const pts = payloadTypes(lines, codec);
  const hint = [
    `x-google-start-bitrate=${Math.round(kbps * 0.85)}`,
    `x-google-min-bitrate=${Math.round(kbps * 0.3)}`,
    `x-google-max-bitrate=${Math.round(kbps)}`,
  ];
  const withFmtp = new Set(lines.map((l) => /^a=fmtp:(\d+) /.exec(l)?.[1]).filter(Boolean));
  const out = [];
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && pts.has(f[1])) {
      const params = f[2].split(';').filter((p) => p && !p.startsWith('x-google-'));
      out.push(`a=fmtp:${f[1]} ${[...params, ...hint].join(';')}`);
      continue;
    }
    out.push(l);
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && pts.has(r[1]) && !withFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${hint.join(';')}`);
  }
  return out.join('\r\n');
}

/**
 * Rewrites profile-level-id on every H.264 payload. Used both to present a GPU-encodable
 * profile to the PC and Constrained Baseline to the TV (see H264_PROFILES), and to lift the
 * level to 5.2: Android's decoder factory always advertises level 3.1 even when MediaCodec
 * handles 4K60.
 */
export function setH264ProfileLevel(sdp, profileLevelId) {
  const lines = sdp.split('\r\n');
  const pts = payloadTypes(lines, 'H264');
  return lines
    .map((l) => {
      const f = /^a=fmtp:(\d+) /.exec(l);
      if (!f || !pts.has(f[1])) return l;
      return l.replace(/profile-level-id=[0-9a-fA-F]{6}/, `profile-level-id=${profileLevelId}`);
    })
    .join('\r\n');
}
