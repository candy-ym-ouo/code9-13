import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EventStreamClient, type SyncEvent, type SyncStatus } from './events.js';
import { useSession } from '../stores/session.js';

let client: EventStreamClient | null = null;
let activeLibrary: string | null = null;
const statusListeners = new Set<(s: SyncStatus) => void>();
let currentStatus: SyncStatus = 'offline';

function setStatus(s: SyncStatus): void {
  currentStatus = s;
  for (const fn of statusListeners) fn(s);
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

/** 订阅连接状态（供顶栏小绿点/灰点使用） */
export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  fn(currentStatus);
  return () => {
    statusListeners.delete(fn);
  };
}

function applyEvent(qc: ReturnType<typeof useQueryClient>, event: SyncEvent): void {
  switch (event.type) {
    case 'asset_processed':
      // 素材处理完成（异步管线）：刷新卡片详情与列表
      void qc.invalidateQueries({ queryKey: ['inspiration'] });
      void qc.invalidateQueries({ queryKey: ['inspirations'] });
      break;
    case 'window_changed':
      // 窗口判定变化：今日页、该卡窗口、计划页都可能受影响
      void qc.invalidateQueries({ queryKey: ['windows'] });
      void qc.invalidateQueries({ queryKey: ['todayWindows'] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
      break;
    case 'reminder_created':
    case 'reminder_updated':
      // 提醒增删改：收件箱/角标/计划联动
      void qc.invalidateQueries({ queryKey: ['reminders'] });
      break;
  }
}

/**
 * 在已登录的 Shell 中挂一次：连接事件流，按事件类型精确失效查询缓存。
 * 同一库全局只保留一条连接；登出/换库时关闭旧连接。
 */
export function useEventSync(): SyncStatus {
  const user = useSession((s) => s.user);
  const qc = useQueryClient();

  useEffect(() => {
    if (!user) {
      client?.close();
      client = null;
      activeLibrary = null;
      setStatus('offline');
      return;
    }
    if (activeLibrary === user.libraryId && client) return;

    client?.close();
    activeLibrary = user.libraryId;
    const next = new EventStreamClient(user.libraryId);
    const offEvent = next.onEvent((event) => applyEvent(qc, event));
    const offResync = next.onResyncRequired(() => void qc.invalidateQueries());
    const offStatus = next.onStatus(setStatus);
    next.connect();
    client = next;

    return () => {
      offEvent();
      offResync();
      offStatus();
    };
  }, [user, qc]);

  return currentStatus;
}
