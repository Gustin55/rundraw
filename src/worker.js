// Calcul en arrière-plan : l'interface reste fluide pendant la construction du graphe et l'ajustement.
// Le graphe est gardé en mémoire : changer le curseur ou retoucher le dessin dans la même zone est instantané.

import { makeProjection, bboxOf, transformPoints } from './geo.js';
import { buildGraph, SpatialIndex } from './graph.js';
import { planRoute } from './router.js';

let zone = null; // { key, proj, graph, index }

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      self.postMessage({ type: 'progress', text: 'Construction du réseau de rues…' });
      const osm = JSON.parse(msg.osmText);
      const proj = makeProjection(msg.center[0], msg.center[1]);
      const graph = buildGraph(osm, proj);
      zone = { key: msg.key, proj, graph, index: new SpatialIndex(graph) };
      self.postMessage({ type: 'loaded', key: msg.key, nodes: graph.mainSize });
      return;
    }
    if (msg.type === 'plan') {
      if (!zone || zone.key !== msg.key) throw new Error('Réseau non chargé.');
      const { proj, graph, index } = zone;
      if (graph.mainSize < 20) throw new Error('Pas assez de rues dans cette zone.');
      self.postMessage({ type: 'progress', text: 'Ajustement du dessin aux rues…' });
      const t0 = performance.now();
      const strokesXY = msg.strokes.map((s) => s.map(([lat, lon]) => proj.toXY(lat, lon)));
      let strokesNow = strokesXY;
      let res = planRoute(graph, index, strokesNow, msg.opts);
      // Distance visée : on remet le dessin à l'échelle jusqu'à tomber à ±4 % (3 essais max).
      if (msg.targetM > 0 && res.parts.length) {
        let best = res;
        for (let it = 0; it < 3 && Math.abs(best.length / msg.targetM - 1) > 0.04; it++) {
          self.postMessage({ type: 'progress', text: `Ajustement à ${(msg.targetM / 1000).toFixed(1)} km…` });
          const ratio = Math.min(1.15, Math.max(0.7, msg.targetM / res.length));
          const bb = bboxOf(strokesNow);
          const c = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
          strokesNow = strokesNow.map((s) => transformPoints(s, c, ratio, 0, 0, 0));
          res = planRoute(graph, index, strokesNow, msg.opts);
          if (Math.abs(res.length - msg.targetM) < Math.abs(best.length - msg.targetM)) best = res;
        }
        res = best;
      }
      if (!res.parts.length) throw new Error('Impossible de suivre ce dessin ici. Essaie une zone avec plus de rues.');
      const ll = (nodes) => nodes.map((i) => [graph.lats[i], graph.lons[i]]);
      self.postMessage({
        type: 'result',
        id: msg.id,
        ms: performance.now() - t0,
        nodes: graph.mainSize,
        length: res.length,
        deviation: res.deviation,
        fit: res.fit ? res.fit.params : null,
        parts: res.parts.map((p) => ({ type: p.type, coords: ll(p.nodes) })),
        fitted: res.fittedStrokes.map((s) => s.map(([x, y]) => proj.toLatLon(x, y))),
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};
