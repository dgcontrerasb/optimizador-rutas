import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TruckTelemetryPayload {
  truckId: string;
  routeId: number;
  routeName: string;
  routeColor: string;
  vehiclePlate: string;
  driverName: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  accuracy: number | null;
  status: 'en_ruta' | 'entregando' | 'detenido' | 'completado';
  statusNote?: string;
  statusSince?: number;
  currentStopIndex: number;
  totalStops: number;
  completedStopIds: number[];
  nextStopClient?: string;
  nextStopAddress?: string;
  updatedAt: number;
  source: 'gps_movil' | 'demo_gps';
  trail?: Array<{ lat: number; lng: number; ts: number }>;
  eventLog?: Array<{ time: string; text: string; status: string }>;
}

const activeTrucks = new Map<string, TruckTelemetryPayload>();
let publishedRoutesSnapshot: any[] = [];

function upsertTruckTelemetry(data: Partial<TruckTelemetryPayload> & { truckId: string }): TruckTelemetryPayload {
  const existing = activeTrucks.get(data.truckId);
  const now = Date.now();
  const lat = Number(data.lat ?? existing?.lat ?? 4.7623889);
  const lng = Number(data.lng ?? existing?.lng ?? -74.1616574);

  const prevTrail = existing?.trail || [];
  const lastPoint = prevTrail[prevTrail.length - 1];
  const movedEnough =
    !lastPoint ||
    Math.abs(lastPoint.lat - lat) > 0.00005 ||
    Math.abs(lastPoint.lng - lng) > 0.00005;

  const updatedTrail = movedEnough
    ? [...prevTrail.slice(-29), { lat, lng, ts: now }]
    : prevTrail;

  const statusChanged = data.status && existing && data.status !== existing.status;

  const merged: TruckTelemetryPayload = {
    truckId: data.truckId,
    routeId: data.routeId !== undefined ? Number(data.routeId) : (existing?.routeId ?? 0),
    routeName: data.routeName || existing?.routeName || `Ruta ${(data.routeId ?? existing?.routeId ?? 0) + 1}`,
    routeColor: data.routeColor || existing?.routeColor || '#EA580C',
    vehiclePlate: data.vehiclePlate || existing?.vehiclePlate || `JMR-${101 + (data.routeId ?? 0)}`,
    driverName: data.driverName || existing?.driverName || `Conductor Ruta ${(data.routeId ?? 0) + 1}`,
    lat,
    lng,
    speedKmh: data.speedKmh !== undefined ? Number(data.speedKmh) : (existing?.speedKmh ?? 0),
    heading: data.heading !== undefined ? data.heading : (existing?.heading ?? null),
    accuracy: data.accuracy !== undefined ? data.accuracy : (existing?.accuracy ?? 12),
    status: data.status || existing?.status || 'en_ruta',
    statusNote: data.statusNote !== undefined ? data.statusNote : existing?.statusNote,
    statusSince: statusChanged ? now : (data.statusSince ?? existing?.statusSince ?? now),
    currentStopIndex: data.currentStopIndex !== undefined ? Number(data.currentStopIndex) : (existing?.currentStopIndex ?? 0),
    totalStops: data.totalStops !== undefined ? Number(data.totalStops) : (existing?.totalStops ?? 0),
    completedStopIds: Array.isArray(data.completedStopIds) ? data.completedStopIds : (existing?.completedStopIds || []),
    nextStopClient: data.nextStopClient !== undefined ? data.nextStopClient : existing?.nextStopClient,
    nextStopAddress: data.nextStopAddress !== undefined ? data.nextStopAddress : existing?.nextStopAddress,
    updatedAt: now,
    source: data.source || existing?.source || 'gps_movil',
    trail: updatedTrail,
    eventLog: Array.isArray(data.eventLog) ? data.eventLog.slice(0, 15) : (existing?.eventLog || [])
  };

  activeTrucks.set(merged.truckId, merged);
  return merged;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json({ limit: '5mb' }));

  // WebSocket Server en el mismo puerto 3000
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = request.url || '';
    if (url.startsWith('/ws/telemetry')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  function broadcast(message: object) {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  wss.on('connection', (ws) => {
    // Enviar estado inicial al conectarse (camiones + rutas activas para terminales de conductor)
    ws.send(
      JSON.stringify({
        type: 'telemetry:init',
        trucks: Array.from(activeTrucks.values()),
        routes: publishedRoutesSnapshot,
        serverTime: Date.now()
      })
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'telemetry:update' && msg.payload && msg.payload.truckId) {
          const updated = upsertTruckTelemetry(msg.payload);
          broadcast({
            type: 'telemetry:updated',
            truck: updated
          });
        } else if (msg.type === 'routes:publish' && Array.isArray(msg.routes)) {
          publishedRoutesSnapshot = msg.routes;
          broadcast({
            type: 'routes:synced',
            routes: publishedRoutesSnapshot
          });
        } else if (msg.type === 'telemetry:remove' && msg.truckId) {
          activeTrucks.delete(String(msg.truckId));
          broadcast({
            type: 'telemetry:removed',
            truckId: String(msg.truckId)
          });
        } else if (msg.type === 'telemetry:clear') {
          activeTrucks.clear();
          broadcast({
            type: 'telemetry:cleared'
          });
        }
      } catch (err) {
        console.error('Error procesando mensaje WS de telemetría:', err);
      }
    });
  });

  // Endpoints HTTP REST de respaldo y consulta directa
  app.get('/api/telemetry', (_req, res) => {
    res.json({
      ok: true,
      trucks: Array.from(activeTrucks.values()),
      routes: publishedRoutesSnapshot,
      serverTime: Date.now()
    });
  });

  app.post('/api/telemetry', (req, res) => {
    const body = req.body;
    if (!body || !body.truckId) {
      res.status(400).json({ ok: false, error: 'truckId es obligatorio' });
      return;
    }
    const updated = upsertTruckTelemetry(body);
    broadcast({
      type: 'telemetry:updated',
      truck: updated
    });
    res.json({ ok: true, truck: updated });
  });

  app.post('/api/routes', (req, res) => {
    if (req.body && Array.isArray(req.body.routes)) {
      publishedRoutesSnapshot = req.body.routes;
      broadcast({
        type: 'routes:synced',
        routes: publishedRoutesSnapshot
      });
    }
    res.json({ ok: true, count: publishedRoutesSnapshot.length });
  });

  app.delete('/api/telemetry/:truckId', (req, res) => {
    const { truckId } = req.params;
    if (truckId === 'all') {
      activeTrucks.clear();
      broadcast({ type: 'telemetry:cleared' });
    } else {
      activeTrucks.delete(truckId);
      broadcast({ type: 'telemetry:removed', truckId });
    }
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RutasJamar TMS + Telemetría GPS Server activo en http://0.0.0.0:${PORT}`);
  });
}

startServer();
