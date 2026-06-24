import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { clientsApi } from '@/services/api';
import { onDataUpdate, onCommandStatus } from '@/services/socket';

interface UseDeviceDataOptions<T> {
  clientId: string;

  page: string;

  extractData: (data: Record<string, unknown>) => T;

  dataType: string | string[];

  defaultValue: T;

  socketDebounceMs?: number;

  staleTimeMs?: number;
}

export type CommandStatus = 'idle' | 'sending' | 'sent' | 'delivered' | 'responded' | 'queued' | 'error';

export interface DeviceDataState<T> {
  data: T;
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;

  sendCommand: (cmd: string, params?: Record<string, unknown>) => Promise<string>;

  lastUpdated: number | null;

  commandStatus: CommandStatus;

  commandSummary: string | null;

  clearData: () => void;
}

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const pageCache = new Map<string, CacheEntry>();

export function invalidatePageCache(clientId?: string, page?: string): void {
  if (!clientId) {
    pageCache.clear();
    return;
  }
  if (!page) {
    for (const key of pageCache.keys()) {
      if (key.startsWith(`${clientId}:`)) pageCache.delete(key);
    }
    return;
  }
  pageCache.delete(`${clientId}:${page}`);
}

export function useDeviceData<T>({
  clientId,
  page,
  extractData,
  dataType,
  defaultValue,
  socketDebounceMs = 2000,
  staleTimeMs = 15000,
}: UseDeviceDataOptions<T>): DeviceDataState<T> {
  const cacheKey = `${clientId}:${page}`;

  const [data, setData] = useState<T>(() => {
    const cached = pageCache.get(cacheKey);
    return cached ? (cached.data as T) : defaultValue;
  });
  const [loading, setLoading] = useState(() => !pageCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>('idle');
  const [commandSummary, setCommandSummary] = useState<string | null>(null);
  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCommandIdRef = useRef<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => {
    const cached = pageCache.get(cacheKey);
    return cached?.timestamp ?? null;
  });

  const extractDataRef = useRef(extractData);
  extractDataRef.current = extractData;

  const dataTypes = useMemo(
    () => (Array.isArray(dataType) ? dataType : [dataType]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Array.isArray(dataType) ? dataType.join(',') : dataType]
  );

  const abortRef = useRef<AbortController | null>(null);

  const lastRefreshRef = useRef(pageCache.has(cacheKey) ? (pageCache.get(cacheKey)?.timestamp ?? 0) : 0);

  const hasDataRef = useRef(pageCache.has(cacheKey));
  hasDataRef.current = data !== defaultValue;

  const clearCommandTimer = useCallback(() => {
    if (commandTimerRef.current) {
      clearTimeout(commandTimerRef.current);
      commandTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    const showSpinner = !hasDataRef.current;
    if (showSpinner) {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await clientsApi.getPage(clientId, page, controller.signal);
      if (controller.signal.aborted) return;
      if (res.data.success) {
        const extracted = extractDataRef.current(res.data.data as Record<string, unknown>);
        setData(extracted);
        const now = Date.now();
        setLastUpdated(now);
        pageCache.set(cacheKey, { data: extracted, timestamp: now });
      } else {
        setError(res.data.error || 'Failed to load data');
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to load data');
    }
    if (!controller.signal.aborted) {
      setLoading(false);
      lastRefreshRef.current = Date.now();
    }
  }, [clientId, page, cacheKey]);

  useEffect(() => {
    const cached = pageCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < staleTimeMs) {
      setLoading(false);
      refresh();
    } else {
      refresh();
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  useEffect(() => {
    const unsub = onDataUpdate((cid, type) => {
      if (cid === clientId && dataTypes.includes(type)) {
        const now = Date.now();
        if (now - lastRefreshRef.current < socketDebounceMs) return;
        lastRefreshRef.current = now;
        refresh();
      }
    });
    return unsub;
  }, [clientId, refresh, dataTypes, socketDebounceMs]);

  useEffect(() => {
    const unsub = onCommandStatus((cid, commandId, status, _dataType) => {
      if (cid !== clientId) return;

      if (activeCommandIdRef.current && commandId !== activeCommandIdRef.current) return;

      if (status === 'delivered') {
        clearCommandTimer();
        setCommandStatus('delivered');
      } else if (status === 'responded') {
        clearCommandTimer();
        setCommandStatus('responded');
        commandTimerRef.current = setTimeout(() => {
          setCommandStatus('idle');
          setCommandSummary(null);
          activeCommandIdRef.current = null;
        }, 5000);
      }
    });
    return unsub;
  }, [clientId, clearCommandTimer]);

  const sendCommand = useCallback(
    async (cmd: string, params: Record<string, unknown> = {}): Promise<string> => {
      clearCommandTimer();
      activeCommandIdRef.current = null;
      setCommandSummary(null);
      setCommandStatus('sending');

      try {
        const res = await clientsApi.sendCommand(clientId, cmd, params);
        const commandId = res.data?.commandId || '';
        const sent = res.data?.sent ?? false;
        const queued = res.data?.queued ?? false;

        activeCommandIdRef.current = commandId;

        if (sent) {
          setCommandStatus('sent');

          commandTimerRef.current = setTimeout(() => {
            setCommandStatus((prev) => prev === 'sent' ? 'delivered' : prev);
          }, 15000);
        } else if (queued) {
          setCommandStatus('queued');
          commandTimerRef.current = setTimeout(() => {
            setCommandStatus('idle');
            activeCommandIdRef.current = null;
          }, 10000);
        } else {
          setCommandStatus('sent');
          commandTimerRef.current = setTimeout(() => {
            setCommandStatus((prev) => prev === 'sent' ? 'delivered' : prev);
          }, 15000);
        }

        return commandId;
      } catch {
        setCommandStatus('error');
        commandTimerRef.current = setTimeout(() => {
          setCommandStatus('idle');
          activeCommandIdRef.current = null;
        }, 4000);
        throw new Error('Command failed');
      }
    },
    [clientId, clearCommandTimer]
  );

  useEffect(() => {
    return () => {
      if (commandTimerRef.current) {
        clearTimeout(commandTimerRef.current);
      }
    };
  }, []);

  const clearData = useCallback(() => {
    pageCache.delete(cacheKey);
    setData(defaultValue);
    setError(null);
    setLastUpdated(null);
    hasDataRef.current = false;
    lastRefreshRef.current = 0;
  }, [cacheKey, defaultValue]);

  return {
    data,
    loading,
    error,
    refresh,
    sendCommand,
    lastUpdated,
    commandStatus,
    commandSummary,
    clearData,
  };
}
