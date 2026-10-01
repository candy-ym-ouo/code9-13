import { useSession } from '../stores/session.js';

/**
 * 多端事件同步中心 · 浏览器客户端
 *
 * 三条核心保证（与服务端 event_log 对应）：
 *  1. 按资料库隔离：流 URL 携带本账号的鉴权 token，服务端只回放/推送本库事件；
 *  2. 断线重连可补漏：EventSource 原生 Last-Event-ID + 本端持久化 lastSeq，
 *     浏览器被杀掉重开后也能带上 ?afterSeq 续传；
 *  3. 同一事件不重复消费：本地按 seq 去重（重放与实时交界可能重叠），
 *     业务侧 react-query 的 invalidateQueries 本身也是幂等的。
 */

export type SyncEventType = 'asset_processed' | 'window_changed' | 'reminder_created' | 'reminder_updated';

export interface SyncEvent {
  type: SyncEventType;
  seq: number;
  eventId: string;
  payload: Record<string, unknown>;
}

export type SyncStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export type EventHandler = (event: SyncEvent) => void;
export type ResyncHandler = () => void;
export type StatusHandler = (status: SyncStatus) => void;

const CLIENT_ID_KEY = 'flil.clientId';
const SEQ_KEY_PREFIX = 'flil.lastSeq.';

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(
      /[^a-zA-Z0-9_-]/g,
      '',
    );
    id = `web_${rnd}`.slice(0, 128);
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function loadSeq(libraryId: string): number {
  const raw = localStorage.getItem(SEQ_KEY_PREFIX + libraryId);
  return raw && /^\d+$/.test(raw) ? Number(raw) : 0;
}

function saveSeq(libraryId: string, seq: number): void {
  if (seq > loadSeq(libraryId)) localStorage.setItem(SEQ_KEY_PREFIX + libraryId, String(seq));
}

const BUSINESS_EVENTS: SyncEventType[] = [
  'asset_processed',
  'window_changed',
  'reminder_created',
  'reminder_updated',
];

export class EventStreamClient {
  private es: EventSource | null = null;
  private eventHandlers = new Set<EventHandler>();
  private resyncHandlers = new Set<ResyncHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private delivered = new Set<number>();
  private status: SyncStatus = 'offline';
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private libraryId: string) {}

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** 服务端告知增量缺口已无法补齐（超过保留窗口）：上层应做一次全量刷新 */
  onResyncRequired(handler: ResyncHandler): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const h of this.statusHandlers) h(status);
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const token = useSession.getState().token;
    if (!token) {
      // 未登录：停在这里，登录后由重新创建的 client 拉起
      this.setStatus('offline');
      return;
    }

    const clientId = getClientId();
    const afterSeq = loadSeq(this.libraryId);
    const params = new URLSearchParams({
      clientId,
      token,
      afterSeq: String(afterSeq),
    });
    const url = `/api/events/stream?${params.toString()}`;

    this.setStatus(afterSeq > 0 || this.es ? 'reconnecting' : 'connecting');
    const es = new EventSource(url);
    this.es = es;

    // 控制事件：hello 后视为在线
    es.addEventListener('hello', () => {
      this.setStatus('online');
    });

    // 历史缺口已无法用事件补全（超过保留窗口/单次回放上限）：交给上层全量刷新
    es.addEventListener('resync_required', () => {
      for (const h of this.resyncHandlers) h();
    });

    for (const type of BUSINESS_EVENTS) {
      es.addEventListener(type, (ev: MessageEvent) => {
        const parsed = this.parse(ev);
        if (parsed) this.dispatch(parsed);
      });
    }

    es.onopen = () => {
      // hello 到达前不提前标 online（可能还在回放）
    };

    es.onerror = () => {
      // EventSource 会自动重连，浏览器在重连时自动带 Last-Event-ID
      this.setStatus('reconnecting');
      if (es.readyState === EventSource.CLOSED) {
        // 服务端明确关闭（如 401）：浏览器不会再自动重连，由我们定时兜底重拉
        this.scheduleReconnect();
      }
    };
  }

  private parse(ev: MessageEvent): SyncEvent | null {
    try {
      const data = JSON.parse(ev.data) as Record<string, unknown>;
      const seq = Number(data.seq);
      const eventId = String(data.eventId ?? '');
      if (!Number.isFinite(seq) || !eventId) return null;
      const { eventId: _e, seq: _s, ...payload } = data;
      return { type: ev.type as SyncEventType, seq, eventId, payload };
    } catch {
      return null;
    }
  }

  private dispatch(event: SyncEvent): void {
    if (event.seq > 0) {
      if (this.delivered.has(event.seq)) return; // 重放/实时重叠：只消费一次
      this.delivered.add(event.seq);
      if (this.delivered.size > 4096) {
        // 集合封顶：seq 单调递增，清掉最旧的一半即可
        const keep = [...this.delivered].sort((a, b) => b - a).slice(0, 2048);
        this.delivered = new Set(keep);
      }
      saveSeq(this.libraryId, event.seq);
    }
    for (const h of this.eventHandlers) h(event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.teardownEs();
      this.open();
    }, 5000);
  }

  private teardownEs(): void {
    if (this.es) {
      this.es.onopen = null;
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownEs();
    this.setStatus('offline');
  }
}
