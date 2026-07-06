import { contextBridge, ipcRenderer } from 'electron';
import type { Api, TxFilter, TxInput, TxType } from '../shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: Api = {
  categories: {
    list: () => invoke('categories:list'),
    create: (data: { name: string; type: TxType; color: string }) => invoke('categories:create', data),
    update: (id: number, data: { name: string; color: string }) => invoke('categories:update', id, data),
    remove: (id: number) => invoke('categories:remove', id),
  },
  transactions: {
    list: (filter: TxFilter) => invoke('tx:list', filter),
    create: (data: TxInput) => invoke('tx:create', data),
    update: (id: number, data: TxInput) => invoke('tx:update', id, data),
    remove: (id: number) => invoke('tx:remove', id),
    exportCsv: (filter: TxFilter) => invoke('tx:exportCsv', filter),
  },
  budgets: {
    list: (month: string) => invoke('budgets:list', month),
    upsert: (categoryId: number, month: string, amountCents: number) =>
      invoke('budgets:upsert', categoryId, month, amountCents),
    copyFromPrevious: (month: string) => invoke('budgets:copyFromPrevious', month),
  },
  reports: {
    summary: (month: string) => invoke('reports:summary', month),
    trend: (endMonth: string, count: number) => invoke('reports:trend', endMonth, count),
    breakdown: (month: string, type: TxType) => invoke('reports:breakdown', month, type),
  },
  app: {
    version: () => invoke('app:version'),
    dbPath: () => invoke('app:dbPath'),
  },
};

contextBridge.exposeInMainWorld('api', api);
