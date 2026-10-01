import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client.js';
import { useSession } from '../stores/session.js';

/**
 * 多端事件同步（素材处理 / 窗口变化 / 提醒更新）。
 *
 * - 每个端（设备/标签页）生成并持久化一个 clientId，服务端按 (资料库, clientId) 存游标；
 * - SSE 每条事件带单调 id，浏览器断线自动带 Last-Event-ID，服务端先补漏再推实时；
 * - 同一事件不重复消费：本地用 Set 去重 + 游标确认（ack），乱序/重复也只处理一次；
 * - 收到事件后失效对应的 react-query 查询，由各页面自动重拉（事件本身不承载实体全量）。
 */

const CLIENT_ID_KEY = 'flil.syncClientId';
const seenCap = 2000;

type SyncEventType = 'asset_processed' | 'window_changed' | 'reminder_created' | 'reminder_updated';

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function useEventSync(): void {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  const seenRef = useRef<Set<number>>(new Set());
  const lastIdRef = useRef(0);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!token) return;

    const clientId = getClientId();
    const url = new URL('/api/events/stream', window.location.origin);
    url.searchParams.set('clientId', clientId);
    // EventSource 无法带鉴权头，用查询参数令牌
    url.searchParams.set('token', token);

    const invalidate = (type: SyncEventType) => {
      // 按事件类型精准失效，避免无谓重拉
      if (type === 'asset_processed') {
        void qc.invalidateQueries({ queryKey: ['inspiration'] });
        void qc.invalidateQueries({ queryKey: ['inspirations'] });
      } else if (type === 'window_changed') {
        void qc.invalidateQueries({ queryKey: ['windows'] });
        void qc.invalidateQueries({ queryKey: ['todayWindows'] });
        void qc.invalidateQueries({ queryKey: ['inspirations'] });
      } else {
        void qc.invalidateQueries({ queryKey: ['reminders'] });
        void qc.invalidateQueries({ queryKey: ['plans'] });
      }
    };

    const handle = (id: number, type: string) => {
      if (!Number.isFinite(id) || seenRef.current.has(id)) return; // 同一事件不重复消费
      seenRef.current.add(id);
      if (seenRef.current.size > seenCap) {
        // 防止长会话无界增长：丢弃最旧的一半
        const arr = [...seenRef.current].sort((a, b) => a - b);
        seenRef.current = new Set(arr.slice(arr.length / 2));
        seenRef.current.add(id);
      }
      lastIdRef.current = Math.max(lastIdRef.current, id);
      invalidate(type as SyncEventType);
      scheduleAck();
    };

    // 游标确认做防抖批量上报：既持久化"已消费到哪"，又不逐事件打请求
    const scheduleAck = () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
      ackTimer.current = setTimeout(() => {
        const lastEventId = lastIdRef.current;
        if (lastEventId > 0) {
          void post('/events/ack', { clientId, lastEventId }).catch(() => undefined);
        }
      }, 1500);
    };

    const es = new EventSource(url.toString());

    // 服务端判定缺口超出保留窗口：丢弃本地缓存，全量重拉
    es.addEventListener('resync', () => {
      void qc.invalidateQueries();
    });

    es.addEventListener('hello', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { lastEventId?: number };
        if (data.lastEventId) lastIdRef.current = Math.max(lastIdRef.current, data.lastEventId);
      } catch {
        /* 忽略畸形 hello */
      }
    });

    for (const type of ['asset_processed', 'window_changed', 'reminder_created', 'reminder_updated'] as const) {
      es.addEventListener(type, (e) => {
        // 浏览器把 SSE 的 id: 放在 lastEventId 上
        const id = Number((e as MessageEvent).lastEventId);
        handle(id, type);
      });
    }

    es.onerror = () => {
      // EventSource 会自动重连并带上 Last-Event-ID；这里无需手动处理，
      // 仅确保重连前把已消费游标落库（重连后服务端据此补漏，不重复）。
      if (ackTimer.current) clearTimeout(ackTimer.current);
      const lastEventId = lastIdRef.current;
      if (lastEventId > 0) void post('/events/ack', { clientId, lastEventId }).catch(() => undefined);
    };

    return () => {
      es.close();
      if (ackTimer.current) clearTimeout(ackTimer.current);
    };
  }, [token, qc]);
}
