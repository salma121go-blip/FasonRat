import { create } from 'zustand';
import type { ClientDevice, DashboardData } from '@/types';
import { dashboardApi, clientsApi } from '@/services/api';

interface DevicesState {
  onlineClients: ClientDevice[];
  offlineClients: ClientDevice[];
  stats: DashboardData['stats'] | null;
  selectedDevice: ClientDevice | null;
  isLoading: boolean;
  error: string | null;
  fetchDashboard: () => Promise<void>;
  fetchClients: () => Promise<void>;
  selectDevice: (device: ClientDevice | null) => void;
  deleteDevice: (id: string) => Promise<boolean>;
}

export const useDevicesStore = create<DevicesState>((set, get) => ({
  onlineClients: [],
  offlineClients: [],
  stats: null,
  selectedDevice: null,
  isLoading: false,
  error: null,

  fetchDashboard: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await dashboardApi.getData();
      if (res.data.success) {
        const data = res.data.data;
        set({
          onlineClients: data.onlineClients,
          offlineClients: data.offlineClients,
          stats: data.stats,
          isLoading: false,
        });
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to load dashboard');
      set({ error: msg, isLoading: false });
    }
  },

  fetchClients: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await clientsApi.getAll();
      if (res.data.success) {
        const data = res.data.data;
        const online = data.clients.filter((c: ClientDevice) => c.online);
        const offline = data.clients.filter((c: ClientDevice) => !c.online);
        set({
          onlineClients: online,
          offlineClients: offline,
          // Preserve existing stats from fetchDashboard, only update client counts
          stats: data.clients ? {
            ...get().stats,
            totalClients: data.total,
            onlineClients: data.online,
            offlineClients: data.offline,
          } as DashboardData['stats'] : get().stats,
          isLoading: false,
        });
      }
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to load clients');
      set({ error: msg, isLoading: false });
    }
  },

  selectDevice: (device) => set({ selectedDevice: device }),

  deleteDevice: async (id) => {
    try {
      const res = await clientsApi.delete(id);
      if (res.data.success) {
        set((state) => ({
          onlineClients: state.onlineClients.filter(c => c.id !== id),
          offlineClients: state.offlineClients.filter(c => c.id !== id),
          selectedDevice: state.selectedDevice?.id === id ? null : state.selectedDevice,
        }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },
}));
