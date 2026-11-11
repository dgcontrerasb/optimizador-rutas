import { COMFORT, DEPOT, LOGISTICS, MAX_DEST, MAX_VOL, MIN_DEST, MIN_VOL, ROAD_CIRCUITY_FACTOR } from '../config/constants';
import { PhysicalDestination } from '../types';
import { S } from '../state/store';
import { classifyZone, hav, isZoneCompatible, normText } from '../config/zones';

export function roadDistance(a: number, b: number, c: number, d: number): number {
  return hav(a, b, c, d) * ROAD_CIRCUITY_FACTOR;
}

export function vol(r: PhysicalDestination[]): number {
  return Math.round(r.reduce((s, x) => s + (x.vol || 0), 0) * 1000) / 1000;
}

export function dist(r: PhysicalDestination[], back = false): number {
  if (!r || !r.length) return 0;
  let p = DEPOT, n = 0;
  r.forEach(s => {
    if (s.lat && s.lng) {
      n += roadDistance(p.lat, p.lng, s.lat, s.lng);
      p = { lat: s.lat, lng: s.lng };
    }
  });
  if (back) n += roadDistance(p.lat, p.lng, DEPOT.lat, DEPOT.lng);
  return Math.round(n * 10) / 10;
}

export function twoOpt(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  if (stops.length <= 2) return stops;
  let best = [...stops];
  let bestDist = dist(best, back);
  let improved = true;
  let iters = 0;

  while (improved && iters < 60) {
    improved = false;
    iters++;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1)
        ];
        const candidateDist = dist(candidate, back);
        if (candidateDist < bestDist - 0.005) {
          best = candidate;
          bestDist = candidateDist;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best;
}

export function orOpt(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  if (stops.length <= 2) return stops;
  let best = [...stops];
  let bestDist = dist(best, back);
  let improved = true;
  let iters = 0;

  while (improved && iters < 35) {
    improved = false;
    iters++;
    for (let chainLen = 1; chainLen <= 2; chainLen++) {
      if (best.length <= chainLen) continue;
      for (let i = 0; i <= best.length - chainLen; i++) {
        const segment = best.slice(i, i + chainLen);
        const remaining = [...best.slice(0, i), ...best.slice(i + chainLen)];
        for (let insertPos = 0; insertPos <= remaining.length; insertPos++) {
          if (insertPos === i) continue;
          const candidate = [
            ...remaining.slice(0, insertPos),
            ...segment,
            ...remaining.slice(insertPos)
          ];
          const candidateDist = dist(candidate, back);
          if (candidateDist < bestDist - 0.005) {
            best = candidate;
            bestDist = candidateDist;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }
  return best;
}

export function localSearchSequence(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  if (!stops || stops.length <= 2) return stops ? [...stops] : [];
  const s1 = twoOpt(stops, back);
  const s2 = orOpt(s1, back);
  return twoOpt(s2, back);
}

export function nn(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  const a = [...stops], out: PhysicalDestination[] = [];
  let p = DEPOT;
  while (a.length) {
    let i = 0, b = Infinity;
    a.forEach((s, j) => {
      if (s.lat && s.lng) {
        const d = hav(p.lat, p.lng, s.lat, s.lng);
        if (d < b) { b = d; i = j; }
      }
    });
    p = { lat: a[i].lat!, lng: a[i].lng! };
    out.push(a.splice(i, 1)[0]);
  }
  return localSearchSequence(out, back);
}

export function nnFar(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  if (!stops || stops.length <= 1) return stops ? [...stops] : [];
  const a = [...stops], out: PhysicalDestination[] = [];
  let farthestIdx = 0;
  let maxDist = -1;
  a.forEach((s, j) => {
    if (s.lat && s.lng) {
      const d = hav(DEPOT.lat, DEPOT.lng, s.lat, s.lng);
      if (d > maxDist) { maxDist = d; farthestIdx = j; }
    }
  });
  let p = a.splice(farthestIdx, 1)[0];
  out.push(p);

  while (a.length) {
    let bestIdx = 0, bestScore = Infinity;
    a.forEach((s, j) => {
      if (s.lat && s.lng && p.lat && p.lng) {
        const dFromPrev = hav(p.lat, p.lng, s.lat, s.lng);
        const dToDepot = hav(DEPOT.lat, DEPOT.lng, s.lat, s.lng);
        const score = dFromPrev - (0.08 * dToDepot);
        if (score < bestScore) { bestScore = score; bestIdx = j; }
      }
    });
    p = a.splice(bestIdx, 1)[0];
    out.push(p);
  }
  return localSearchSequence(out, back);
}

export function sweep(stops: PhysicalDestination[], back = false): PhysicalDestination[] {
  if (!stops || stops.length <= 2) return localSearchSequence(stops, back);
  const cLat = stops.reduce((sum, s) => sum + (s.lat || 0), 0) / stops.length;
  const cLng = stops.reduce((sum, s) => sum + (s.lng || 0), 0) / stops.length;

  let nearestToDepot = stops[0];
  let minDepotD = Infinity;
  stops.forEach(s => {
    if (s.lat && s.lng) {
      const d = hav(DEPOT.lat, DEPOT.lng, s.lat, s.lng);
      if (d < minDepotD) { minDepotD = d; nearestToDepot = s; }
    }
  });
  const baseAngle = Math.atan2((nearestToDepot.lat || 0) - cLat, (nearestToDepot.lng || 0) - cLng);

  const sorted = [...stops].sort((a, b) => {
    let angA = Math.atan2((a.lat || 0) - cLat, (a.lng || 0) - cLng) - baseAngle;
    let angB = Math.atan2((b.lat || 0) - cLat, (b.lng || 0) - cLng) - baseAngle;
    if (angA < 0) angA += 2 * Math.PI;
    if (angB < 0) angB += 2 * Math.PI;
    return angA - angB;
  });
  return localSearchSequence(sorted, back);
}

export function isReturnDepot(): boolean {
  const el = document.getElementById('returnDepot') as HTMLInputElement | null;
  return el ? el.checked : false;
}

export function alternatives(stops: PhysicalDestination[]): {
  a: PhysicalDestination[];
  b: PhysicalDestination[];
  da: number;
  db: number;
  chosen: 'A' | 'B';
} {
  const back = isReturnDepot();
  if (!stops || !stops.length) {
    return { a: [], b: [], da: 0, db: 0, chosen: 'A' };
  }
  const candNear = nn(stops, back);
  const candFar = nnFar(stops, back);
  const candSweep = sweep(stops, back);

  const dNear = dist(candNear, back);
  const dFar = dist(candFar, back);
  const dSweep = dist(candSweep, back);

  const seqSignature = (arr: PhysicalDestination[]) => arr.map(x => x.id).join('-');

  const pool = [
    { seq: candNear, d: dNear, sig: seqSignature(candNear) },
    { seq: candFar, d: dFar, sig: seqSignature(candFar) },
    { seq: candSweep, d: dSweep, sig: seqSignature(candSweep) }
  ];

  const a = candNear;
  const da = dNear;
  const sigA = seqSignature(a);

  const distinctCandidates = pool.filter(c => c.sig !== sigA).sort((x, y) => x.d - y.d);
  let b = distinctCandidates.length ? distinctCandidates[0].seq : candSweep;
  if (seqSignature(b) === sigA && stops.length > 1) {
    b = [...a].reverse();
  }
  const db = dist(b, back);

  return { a, b, da, db, chosen: da <= db ? 'A' : 'B' };
}

export function active(r: any): PhysicalDestination[] {
  if (!r) return [];
  if (r.alts) {
    return r.option === 'A' ? (r.alts.a || []) : (r.alts.b || []);
  }
  return r.stops || [];
}

export function avgDistToCluster(s: Partial<PhysicalDestination>, clust: PhysicalDestination[]): number {
  if (!s || !clust || !clust.length) return Infinity;
  const valid = clust.filter(c => c && Number.isFinite(c.lat) && Number.isFinite(c.lng));
  if (!valid.length || !s.lat || !s.lng) return Infinity;
  return valid.reduce((sum, c) => sum + hav(s.lat!, s.lng!, c.lat!, c.lng!), 0) / valid.length;
}

export function estimateRouteTime(stops: PhysicalDestination[], distanceKm: number): {
  travelMinutes: number;
  serviceMinutes: number;
  totalMinutes: number;
  finishMinutes: number;
  finishTimeStr: string;
  exceeds5pm: boolean;
  diffMinutes5pm: number;
} {
  if (!stops || !stops.length) {
    return {
      travelMinutes: 0,
      serviceMinutes: 0,
      totalMinutes: 0,
      finishTimeStr: '07:30 AM',
      finishMinutes: LOGISTICS.START_TIME_MINUTES,
      exceeds5pm: false,
      diffMinutes5pm: 0
    };
  }

  const travelMinutes = Math.round((distanceKm / LOGISTICS.BASE_SPEED_KMH) * 60);
  const serviceMinutes = stops.reduce((acc, s) => {
    const m3 = s.vol || 0;
    return acc + Math.round(LOGISTICS.BASE_STOP_MINUTES + (m3 * LOGISTICS.MINUTES_PER_M3));
  }, 0);

  const totalMinutes = travelMinutes + serviceMinutes;
  const finishMinutes = LOGISTICS.START_TIME_MINUTES + totalMinutes;

  const hh = Math.floor(finishMinutes / 60);
  const mm = Math.floor(finishMinutes % 60);
  const period = hh >= 12 ? 'PM' : 'AM';
  const displayH = hh > 12 ? hh - 12 : hh;
  const finishTimeStr = `${displayH}:${mm < 10 ? '0' : ''}${mm} ${period}`;

  const exceeds5pm = finishMinutes > LOGISTICS.MAX_END_TIME_MINUTES;
  const diffMinutes5pm = finishMinutes - LOGISTICS.MAX_END_TIME_MINUTES;

  return {
    travelMinutes,
    serviceMinutes,
    totalMinutes,
    finishMinutes,
    finishTimeStr,
    exceeds5pm,
    diffMinutes5pm
  };
}

export function getClusterEstimatedFinishMinutes(clust: PhysicalDestination[]): number {
  if (!clust || !clust.length) return LOGISTICS.START_TIME_MINUTES;
  const approxKm = dist(clust, isReturnDepot());
  return estimateRouteTime(clust, approxKm).finishMinutes;
}

export function consolidateCoLocatedStops(): void {
  if (!S.destinations || S.destinations.length < 2) return;
  const mergedRemoveIds = new Set<number>();

  for (let i = 0; i < S.destinations.length; i++) {
    const a = S.destinations[i];
    if (!a || !a.lat || !a.lng || mergedRemoveIds.has(a.id)) continue;
    if (a.confidence === 'Encontrada aproximadamente') continue;

    for (let j = i + 1; j < S.destinations.length; j++) {
      const b = S.destinations[j];
      if (!b || !b.lat || !b.lng || mergedRemoveIds.has(b.id)) continue;
      if (b.confidence === 'Encontrada aproximadamente') continue;

      if (normText(a.ciudad) !== normText(b.ciudad)) continue;

      const dKm = hav(a.lat, a.lng, b.lat, b.lng);
      if (dKm <= 0.012 && (a.vol + b.vol) <= MAX_VOL) {
        (a as any).entregas = [...((a as any).entregas || []), ...((b as any).entregas || [])];
        ((b as any).pedidos || []).forEach((ped: any) => {
          if (!((a as any).pedidos || []).includes(ped)) {
            (a as any).pedidos = (a as any).pedidos || [];
            (a as any).pedidos.push(ped);
          }
        });
        a.vol = Math.round((a.vol + b.vol) * 1000) / 1000;
        (a as any).numOrders = ((a as any).pedidos || []).length;
        (a as any).isMultiDelivery = ((a as any).entregas || []).length > 1;

        const distinctClients = Array.from(new Set(((a as any).entregas || []).map((e: any) => e.cliente)));
        (a as any).clienteDisplay = distinctClients.length > 1
          ? `${(a as any).entregas.length} entregas: ${distinctClients.join(' · ')}`
          : `${distinctClients[0]} (${(a as any).entregas.length} entregas)`;

        mergedRemoveIds.add(b.id);
      }
    }
  }

  if (mergedRemoveIds.size > 0) {
    S.destinations = S.destinations.filter(d => !mergedRemoveIds.has(d.id));
    const statDEl = document.querySelector('#statD div');
    if (statDEl) statDEl.textContent = String(S.destinations.length);
  }
}

export function absorbSmallClusters(clusters: PhysicalDestination[][]): PhysicalDestination[][] {
  if (!clusters || clusters.length < 2) return clusters;
  let mergedAny = true;
  let guard = 0;

  while (mergedAny && guard < 10 && clusters.length > 1) {
    mergedAny = false;
    guard++;

    clusters.sort((a, b) => a.length - b.length || vol(a) - vol(b));

    for (let i = 0; i < clusters.length; i++) {
      const small = clusters[i];
      if (!small.length || small.length > 5) continue;

      const simClusters = clusters.map(c => [...c]);
      let allPlaced = true;

      for (let sIdx = 0; sIdx < small.length; sIdx++) {
        const stop = small[sIdx];
        let bestTarget = -1;
        let bestScore = Infinity;

        for (let j = 0; j < simClusters.length; j++) {
          if (i === j || !simClusters[j].length) continue;
          const candidateCluster = simClusters[j];

          if (candidateCluster.length + 1 > MAX_DEST) continue;
          if (vol(candidateCluster) + stop.vol > MAX_VOL) continue;
          if (!isZoneCompatible(candidateCluster, stop)) continue;

          const d = avgDistToCluster(stop, candidateCluster);
          const isSabana = stop.zone && stop.zone.includes('SABANA');
          const maxMergeDist = isSabana ? 9.0 : 5.8;
          if (d > maxMergeDist) continue;

          const finishMin = getClusterEstimatedFinishMinutes(candidateCluster);
          const softTimePenalty = finishMin > LOGISTICS.MAX_END_TIME_MINUTES ? 1.0 : 0;
          const score = d + softTimePenalty;

          if (score < bestScore) {
            bestScore = score;
            bestTarget = j;
          }
        }

        if (bestTarget !== -1) {
          simClusters[bestTarget].push(stop);
        } else {
          allPlaced = false;
          break;
        }
      }

      if (allPlaced) {
        simClusters.splice(i, 1);
        clusters = simClusters;
        mergedAny = true;
        break;
      }
    }
  }

  return clusters.filter(c => c.length > 0);
}

export function crossRouteOptimization(clusters: PhysicalDestination[][]): PhysicalDestination[][] {
  if (!clusters || clusters.length < 2) return clusters;
  const isComfort = (S.routeDistributionMode || 'comfort') === 'comfort';
  const targetMaxDest = isComfort ? COMFORT.SOFT_MAX_DEST : MAX_DEST;
  const hardMaxDest = MAX_DEST;
  const hardMaxVol = MAX_VOL;

  function routeDist(stops: PhysicalDestination[]): number {
    if (!stops || stops.length <= 1) return 0;
    const seq = alternatives(stops);
    return seq.chosen === 'A' ? seq.da : seq.db;
  }

  let improved = true;
  let passes = 0;
  const maxPasses = 12;

  while (improved && passes < maxPasses) {
    improved = false;
    passes++;

    for (let i = 0; i < clusters.length; i++) {
      const routeA = clusters[i];
      if (routeA.length <= 2) continue;

      const cLatA = routeA.reduce((sum, s) => sum + (s.lat || 0), 0) / routeA.length;
      const cLngA = routeA.reduce((sum, s) => sum + (s.lng || 0), 0) / routeA.length;
      const distA = routeDist(routeA);
      const finishA = estimateRouteTime(routeA, distA).finishMinutes;

      for (let sIdx = 0; sIdx < routeA.length; sIdx++) {
        const stop = routeA[sIdx];
        if (!stop.lat || !stop.lng) continue;
        const distToCenterA = hav(stop.lat, stop.lng, cLatA, cLngA);

        let bestTarget = -1;
        let bestSavings = 0.5;

        for (let j = 0; j < clusters.length; j++) {
          if (i === j) continue;
          const routeB = clusters[j];

          if (routeB.length + 1 > hardMaxDest) continue;
          if (vol(routeB) + stop.vol > hardMaxVol) continue;
          if (!isZoneCompatible(routeB, stop)) continue;

          const cLatB = routeB.reduce((sum, s) => sum + (s.lat || 0), 0) / routeB.length;
          const cLngB = routeB.reduce((sum, s) => sum + (s.lng || 0), 0) / routeB.length;
          const distToCenterB = hav(stop.lat, stop.lng, cLatB, cLngB);

          if (distToCenterB > distToCenterA + 3.0) continue;

          const distB = routeDist(routeB);
          const finishB = estimateRouteTime(routeB, distB).finishMinutes;
          const newA = routeA.filter((_, idx) => idx !== sIdx);
          const newB = [...routeB, stop];

          const newDistA = routeDist(newA);
          const newDistB = routeDist(newB);

          const timeBonus = (finishA > LOGISTICS.MAX_END_TIME_MINUTES && finishB + 25 <= LOGISTICS.MAX_END_TIME_MINUTES) ? 0.35 : 0;
          const savings = (distA + distB) - (newDistA + newDistB) + timeBonus;

          const minRequiredSavings = (isComfort && routeB.length >= targetMaxDest) ? 2.2 : 0.5;
          if (savings > bestSavings && savings >= minRequiredSavings) {
            bestSavings = savings;
            bestTarget = j;
          }
        }

        if (bestTarget !== -1) {
          const moved = routeA.splice(sIdx, 1)[0];
          clusters[bestTarget].push(moved);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }

    if (improved) continue;

    for (let i = 0; i < clusters.length; i++) {
      const routeA = clusters[i];
      for (let j = i + 1; j < clusters.length; j++) {
        const routeB = clusters[j];

        const baseDistAB = routeDist(routeA) + routeDist(routeB);
        let bestSwapA = -1;
        let bestSwapB = -1;
        let bestSwapSavings = 0.7;

        for (let aIdx = 0; aIdx < routeA.length; aIdx++) {
          const stopA = routeA[aIdx];
          for (let bIdx = 0; bIdx < routeB.length; bIdx++) {
            const stopB = routeB[bIdx];

            const newVolA = vol(routeA) - stopA.vol + stopB.vol;
            const newVolB = vol(routeB) - stopB.vol + stopA.vol;
            if (newVolA > hardMaxVol || newVolB > hardMaxVol) continue;

            const tempA = routeA.filter((_, idx) => idx !== aIdx).concat(stopB);
            const tempB = routeB.filter((_, idx) => idx !== bIdx).concat(stopA);

            if (!isZoneCompatible(tempA.filter(s => s !== stopB), stopB)) continue;
            if (!isZoneCompatible(tempB.filter(s => s !== stopA), stopA)) continue;

            const newDistAB = routeDist(tempA) + routeDist(tempB);
            const savings = baseDistAB - newDistAB;

            if (savings > bestSwapSavings) {
              bestSwapSavings = savings;
              bestSwapA = aIdx;
              bestSwapB = bIdx;
            }
          }
        }

        if (bestSwapA !== -1 && bestSwapB !== -1) {
          const itemA = routeA[bestSwapA];
          const itemB = routeB[bestSwapB];
          routeA[bestSwapA] = itemB;
          routeB[bestSwapB] = itemA;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return clusters.filter(c => c.length > 0);
}

export function clusterStrictZones(valid: PhysicalDestination[]): PhysicalDestination[][] {
  const unassigned = [...valid];
  let clusters: PhysicalDestination[][] = [];
  const isComfort = (S.routeDistributionMode || 'comfort') === 'comfort';

  const initialMaxDest = isComfort ? COMFORT.SOFT_MAX_DEST : MAX_DEST;
  const initialMaxVol = isComfort ? COMFORT.SOFT_MAX_VOL : MAX_VOL;

  while (unassigned.length) {
    unassigned.sort((a, b) => hav(DEPOT.lat, DEPOT.lng, b.lat!, b.lng!) - hav(DEPOT.lat, DEPOT.lng, a.lat!, a.lng!));
    const seed = unassigned.shift()!;
    const cluster = [seed];

    let found = true;
    while (found && cluster.length < initialMaxDest && vol(cluster) < initialMaxVol) {
      found = false;
      const cLat = cluster.reduce((sum, x) => sum + x.lat!, 0) / cluster.length;
      const cLng = cluster.reduce((sum, x) => sum + x.lng!, 0) / cluster.length;

      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 0; i < unassigned.length; i++) {
        const cand = unassigned[i];

        if (vol(cluster) + cand.vol > initialMaxVol) continue;
        if (cluster.length + 1 > initialMaxDest) continue;
        if (!isZoneCompatible(cluster, cand)) continue;

        let zonePenalty = 0;
        if (cluster[0] && cand.zone !== cluster[0].zone) {
          zonePenalty = 2.2;
        }
        const d = hav(cLat, cLng, cand.lat!, cand.lng!) + zonePenalty;
        if (d < bestScore) {
          bestScore = d;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1) {
        cluster.push(unassigned.splice(bestIdx, 1)[0]);
        found = true;
      }
    }
    clusters.push(cluster);
  }

  if (unassigned.length > 0) {
    for (let u = unassigned.length - 1; u >= 0; u--) {
      const leftover = unassigned[u];
      let bestClusterIdx = -1;
      let minExtraDist = Infinity;

      for (let c = 0; c < clusters.length; c++) {
        const clust = clusters[c];
        if (clust.length + 1 <= MAX_DEST && vol(clust) + leftover.vol <= MAX_VOL && isZoneCompatible(clust, leftover)) {
          const d = avgDistToCluster(leftover, clust);
          if (d <= 6.5 && d < minExtraDist) {
            minExtraDist = d;
            bestClusterIdx = c;
          }
        }
      }

      if (bestClusterIdx !== -1) {
        clusters[bestClusterIdx].push(leftover);
        unassigned.splice(u, 1);
      } else {
        clusters.push([leftover]);
        unassigned.splice(u, 1);
      }
    }
  }

  clusters = absorbSmallClusters(clusters);

  let balanced = true;
  let iterations = 0;
  const maxIterations = isComfort ? 12 : 8;

  while (balanced && iterations < maxIterations) {
    balanced = false;
    iterations++;

    clusters.sort((a, b) => a.length - b.length || vol(a) - vol(b));

    for (let i = 0; i < clusters.length; i++) {
      const small = clusters[i];

      const targetMinDest = isComfort ? COMFORT.TARGET_DEST : MIN_DEST;
      const targetMinVol = isComfort ? COMFORT.TARGET_VOL : MIN_VOL;

      if (small.length >= targetMinDest || vol(small) >= targetMinVol) continue;
      if (getClusterEstimatedFinishMinutes(small) >= LOGISTICS.MAX_END_TIME_MINUTES) continue;

      let bestDonor = -1;
      let bestStopIdx = -1;
      let minTransferScore = Infinity;

      for (let j = clusters.length - 1; j >= 0; j--) {
        if (i === j) continue;
        const donor = clusters[j];

        const donorMinLeaves = isComfort ? 7 : 6;
        if (donor.length <= donorMinLeaves || donor.length <= small.length + 1) continue;

        const donorFinishMin = getClusterEstimatedFinishMinutes(donor);
        const donorTimeDiscount = donorFinishMin > LOGISTICS.MAX_END_TIME_MINUTES ? -1.0 : 0;

        for (let k = 0; k < donor.length; k++) {
          const candidateStop = donor[k];

          if (small.length + 1 > MAX_DEST || vol(small) + candidateStop.vol > MAX_VOL) continue;
          if (!isZoneCompatible(small, candidateStop)) continue;

          const distToSmall = avgDistToCluster(candidateStop, small);
          const isSabana = candidateStop.zone && candidateStop.zone.includes('SABANA');
          const maxAllowedDist = isSabana ? 8.5 : 4.5;

          const transferScore = distToSmall + donorTimeDiscount;
          if (distToSmall <= maxAllowedDist && transferScore < minTransferScore) {
            minTransferScore = transferScore;
            bestDonor = j;
            bestStopIdx = k;
          }
        }
      }

      if (bestDonor !== -1 && bestStopIdx !== -1) {
        const moved = clusters[bestDonor].splice(bestStopIdx, 1)[0];
        small.push(moved);
        balanced = true;
        break;
      }
    }
  }

  clusters = crossRouteOptimization(clusters);
  clusters = absorbSmallClusters(clusters);

  return clusters.filter(c => c.length > 0);
}

export function deduplicateFleetStops(): void {
  if (!S.routes || !S.routes.length) return;
  const seenIds = new Set<number>();

  S.routes.forEach((r: any) => {
    if (!r.alts) return;
    const curStops = active(r);
    const uniqueStops: PhysicalDestination[] = [];

    curStops.forEach((s: any) => {
      if (s && s.id !== undefined && !seenIds.has(s.id)) {
        seenIds.add(s.id);
        uniqueStops.push(s);
      }
    });

    if (uniqueStops.length !== curStops.length) {
      r.alts = alternatives(uniqueStops);
      delete r._osrmCache;
    }
  });
}

export function buildGroups(): PhysicalDestination[][] {
  consolidateCoLocatedStops();
  const valid = S.destinations.filter(d => d.lat && d.lng && d.vol <= MAX_VOL);
  if (!valid.length) return [];
  valid.forEach(d => {
    d.zone = classifyZone(d);
  });
  return clusterStrictZones(valid);
}
