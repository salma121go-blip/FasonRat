import { io, type Socket } from 'socket.io-client';

let adminSocket: Socket | null = null;

type DataChangeListener = (clientId: string, dataType: string, payload?: Record<string, unknown>) => void;
type TransferListener = (clientId: string, transfer: { transferId: string; name: string; totalChunks: number; totalSize: number; progress: number }) => void;
type BuilderProgressListener = (progress: BuilderProgress) => void;
type CommandStatusListener = (clientId: string, commandId: string, status: string, dataType?: string) => void;

export interface BuilderProgress {
  step: string;
  message: string;
  complete: boolean;
  error: string | null;
  time: string;
  appName?: string;
}

const dataListeners: Set<DataChangeListener> = new Set();
const transferListeners: Set<TransferListener> = new Set();
const builderProgressListeners: Set<BuilderProgressListener> = new Set();
const commandStatusListeners: Set<CommandStatusListener> = new Set();

const getToken = (): string => {
  try {
    return localStorage.getItem('auth-token') || '';
  } catch { return ''; }
};

export function initAdminSocket(onDeviceChange?: () => void): Socket {
  if (adminSocket) {
    adminSocket.removeAllListeners();
    adminSocket.disconnect();
  }

  const token = getToken();

  const s = io({
    transports: ['polling', 'websocket'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    query: { admin: 'true' },
    auth: { token },
  });

  s.io.on('reconnect_attempt', () => {
    s.auth = { token: getToken() };
  });
  s.on('client:connect', () => onDeviceChange?.());
  s.on('client:disconnect', () => onDeviceChange?.());
  s.on('client:data', (payload: { id: string; dataType: string; [key: string]: unknown }) => {
    onDeviceChange?.();
    const { id, dataType, ...extra } = payload;
    dataListeners.forEach((fn) => fn(id, dataType, Object.keys(extra).length > 0 ? extra : undefined));
  });
  s.on('client:update', (payload: { id: string; dataType: string; [key: string]: unknown }) => {
    onDeviceChange?.();
    const { id, dataType, ...extra } = payload;
    dataListeners.forEach((fn) => fn(id, dataType, Object.keys(extra).length > 0 ? extra : undefined));
  });
  s.on('client:transfer', (payload: { id: string; transferId: string; name: string; totalChunks: number; totalSize: number; progress: number }) => {
    transferListeners.forEach((fn) => fn(payload.id, payload));
  });
  s.on('builder:progress', (payload: BuilderProgress) => {
    builderProgressListeners.forEach((fn) => fn(payload));
  });
  s.on('client:command', (payload: { id: string; commandId: string; status: string; dataType?: string }) => {
    commandStatusListeners.forEach((fn) => fn(payload.id, payload.commandId, payload.status, payload.dataType));
  });

  adminSocket = s;
  return s;
}

export function disconnectAdminSocket(): void {
  if (adminSocket) {
    adminSocket.removeAllListeners();
    adminSocket.disconnect();
    adminSocket = null;
  }
  dataListeners.clear();
  transferListeners.clear();
  builderProgressListeners.clear();
  commandStatusListeners.clear();
}

export function onDataUpdate(listener: DataChangeListener): () => void {
  dataListeners.add(listener);
  return () => { dataListeners.delete(listener); };
}

export function onTransferUpdate(listener: TransferListener): () => void {
  transferListeners.add(listener);
  return () => { transferListeners.delete(listener); };
}

export function onBuilderProgress(listener: BuilderProgressListener): () => void {
  builderProgressListeners.add(listener);
  return () => { builderProgressListeners.delete(listener); };
}

export function onCommandStatus(listener: CommandStatusListener): () => void {
  commandStatusListeners.add(listener);
  return () => { commandStatusListeners.delete(listener); };
}
