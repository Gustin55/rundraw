// Export GPX 1.1.

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * segments : tableau de segments, chacun un tableau de [lat, lon].
 * Un seul segment = un parcours continu ; plusieurs = coupures (pause du GPS).
 */
export function toGPX(segments, name = 'RunDraw') {
  const segXml = segments
    .filter((s) => s.length)
    .map((s) => '    <trkseg>\n' +
      s.map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`).join('\n') +
      '\n    </trkseg>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunDraw" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>running</type>
${segXml}
  </trk>
</gpx>
`;
}
