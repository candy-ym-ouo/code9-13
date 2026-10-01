import { useEffect, useSyncExternalStore } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Layout, Menu, Space, Tag, Tooltip, Typography } from 'antd';
import { get } from './api/client.js';
import { useReminders } from './api/hooks.js';
import { getSyncStatus, subscribeSyncStatus, useEventSync } from './api/useEventSync.js';
import type { SyncStatus } from './api/events.js';
import { useSession } from './stores/session.js';
import Login from './routes/Login.js';
import Today from './routes/Today.js';
import Inbox from './routes/Inbox.js';
import Inspirations from './routes/Inspirations.js';
import InspirationDetail from './routes/InspirationDetail.js';
import Albums from './routes/Albums.js';
import AlbumDetail from './routes/AlbumDetail.js';
import Search from './routes/Search.js';
import Places from './routes/Places.js';
import Plans from './routes/Plans.js';
import Settings from './routes/Settings.js';
import ShareView from './routes/ShareView.js';

const { Header, Sider, Content } = Layout;

const STATUS_META: Record<SyncStatus, { color: string; text: string; tip: string }> = {
  connecting: { color: '#faad14', text: '连接中', tip: '正在建立多端事件流' },
  online: { color: '#52c41a', text: '实时同步', tip: '素材处理、窗口变化与提醒更新会实时推送；断线重连自动补漏' },
  reconnecting: { color: '#fa8c16', text: '重连补漏中', tip: '连接已断开，正在重连；期间事件不会丢失，重连后按序号补投' },
  offline: { color: '#bfbfbf', text: '未连接', tip: '事件流未连接，数据仍可手动刷新' },
};

function SyncIndicator() {
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
  const meta = STATUS_META[status];
  return (
    <Tooltip title={meta.tip}>
      <Tag
        style={{ marginInlineEnd: 0, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'default' }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: meta.color,
            boxShadow: status === 'online' ? `0 0 6px ${meta.color}` : 'none',
          }}
        />
        {meta.text}
      </Tag>
    </Tooltip>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, libraryTz, setLibraryTz, clear } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: reminders } = useReminders('pending,notified');
  useEventSync();

  useEffect(() => {
    if (!user) return;
    void get<{ library: { tz: string } }>('/library')
      .then((r) => setLibraryTz(r.library.tz))
      .catch(() => undefined);
  }, [user, setLibraryTz]);

  if (!user) return <Navigate to="/login" replace />;

  const items = [
    { key: '/', label: <Link to="/">今日</Link> },
    { key: '/inbox', label: <Link to="/inbox">收件箱</Link> },
    { key: '/inspirations', label: <Link to="/inspirations">灵感卡</Link> },
    { key: '/search', label: <Link to="/search">检索</Link> },
    {
      key: '/plans',
      label: (
        <Space>
          <Link to="/plans">计划</Link>
          {reminders?.items.length ? <Badge count={reminders.items.length} size="small" /> : null}
        </Space>
      ),
    },
    { key: '/albums', label: <Link to="/albums">画册</Link> },
    { key: '/places', label: <Link to="/places">地点</Link> },
    { key: '/settings', label: <Link to="/settings">设置</Link> },
  ];

  const selected = items
    .map((i) => i.key)
    .filter((k) => (k === '/' ? location.pathname === '/' : location.pathname.startsWith(k)));

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#12303f' }}>
        <Space>
          <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
            电影取景灵感库
          </Typography.Title>
          <Typography.Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            收下这束光，也收下它的条件
          </Typography.Text>
        </Space>
        <Space>
          <SyncIndicator />
          <Tag color="blue">时区 {libraryTz}</Tag>
          <Typography.Text style={{ color: '#fff' }}>{user.displayName}</Typography.Text>
          <Button
            size="small"
            onClick={() => {
              clear();
              navigate('/login');
            }}
          >
            退出
          </Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={150} theme="light">
          <Menu mode="inline" selectedKeys={selected} items={items} style={{ height: '100%', borderRight: 0 }} />
        </Sider>
        <Content style={{ padding: 20, background: '#f5f7f8' }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/share/:token" element={<ShareView />} />
      <Route
        path="*"
        element={
          <Shell>
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/inspirations" element={<Inspirations />} />
              <Route path="/inspirations/:id" element={<InspirationDetail />} />
              <Route path="/search" element={<Search />} />
              <Route path="/plans" element={<Plans />} />
              <Route path="/albums" element={<Albums />} />
              <Route path="/albums/:id" element={<AlbumDetail />} />
              <Route path="/places" element={<Places />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        }
      />
    </Routes>
  );
}
