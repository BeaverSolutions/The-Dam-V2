import React, { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, GitBranch, MessageSquare, CheckCircle,
  Activity, Calendar, Users, MessageCircle, Settings, Menu, X, Bell, LogOut, Brain, ShieldCheck,
} from 'lucide-react';
import BeaverAvatar from './BeaverAvatar';
import { clearToken, getUser } from '../utils/auth';
import { useApi } from '../hooks/useApi';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/pipeline', label: 'Pipeline', icon: GitBranch },
  { path: '/messages', label: 'Messages', icon: MessageSquare },
  { path: '/approvals', label: 'Approvals', icon: CheckCircle, badge: true },
  { path: '/logs', label: 'Activity Log', icon: Activity },
  { path: '/calendar', label: 'Calendar', icon: Calendar },
  { path: '/team', label: 'The Crew', icon: Users },
  { path: '/chat', label: 'Director Chat', icon: MessageCircle },
  { path: '/memory', label: 'Memory', icon: Brain },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const user = getUser();
  const { request } = useApi();
  const isSuperAdmin = user?.role === 'admin';

  useEffect(() => {
    request('/approvals?status=pending&perPage=1')
      .then(res => setPendingCount(res?.meta?.total || 0))
      .catch(() => {});
  }, [location.pathname]);

  const handleLogout = () => {
    clearToken();
    navigate('/login');
  };

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const sidebar = (
    <nav style={{
      width: 'var(--sidebar-width)',
      background: 'var(--panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      position: 'fixed',
      left: 0, top: 0, bottom: 0,
      zIndex: 100,
      transform: sidebarOpen ? 'translateX(0)' : undefined,
      transition: 'transform var(--transition)',
    }}>
      {/* Logo */}
      <div style={{ padding: '1.25rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <BeaverAvatar agent="director" size="xs" />
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--lime)' }}>The Dam</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>v2 — Autonomous</div>
        </div>
      </div>

      {/* Nav items */}
      <div style={{ flex: 1, padding: '0.75rem 0', overflowY: 'auto' }}>
        {navItems.map(({ path, label, icon: Icon, badge }) => (
          <button
            key={path}
            onClick={() => { navigate(path); setSidebarOpen(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.625rem 1rem',
              background: isActive(path) ? 'rgba(200,255,0,0.08)' : 'transparent',
              color: isActive(path) ? 'var(--lime)' : 'var(--text-muted)',
              border: 'none',
              borderLeft: isActive(path) ? '3px solid var(--lime)' : '3px solid transparent',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: isActive(path) ? 600 : 400,
              textAlign: 'left',
              transition: 'all var(--transition)',
            }}
          >
            <Icon size={16} />
            {label}
            {badge && pendingCount > 0 && (
              <span className="nav-badge">{pendingCount > 99 ? '99+' : pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Super Admin link — only for Beaver Solutions */}
      {isSuperAdmin && (
        <div style={{ padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => { navigate('/admin'); setSidebarOpen(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.625rem 1rem',
              background: isActive('/admin') ? 'rgba(168,85,247,0.1)' : 'transparent',
              color: isActive('/admin') ? 'var(--purple)' : 'var(--text-muted)',
              border: 'none',
              borderLeft: isActive('/admin') ? '3px solid var(--purple)' : '3px solid transparent',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: isActive('/admin') ? 600 : 400,
              textAlign: 'left',
            }}
          >
            <ShieldCheck size={16} />
            Super Admin
          </button>
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: '1rem', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {user?.email || 'Admin'}
        </div>
        <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start', padding: '0.4rem 0' }} onClick={handleLogout}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Desktop sidebar */}
      <div className="desktop-sidebar" style={{ width: 'var(--sidebar-width)', flexShrink: 0 }}>
        {sidebar}
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 99 }}
        />
      )}

      {/* Mobile sidebar */}
      <div className="mobile-sidebar" style={{ display: 'none' }}>
        {sidebar}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar */}
        <header style={{
          height: 56,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 1.5rem',
          gap: '1rem',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}>
          <button className="btn btn-ghost" style={{ padding: '0.25rem', display: 'none' }} onClick={() => setSidebarOpen(!sidebarOpen)} id="hamburger">
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(200,255,0,0.1)', border: '1px solid rgba(200,255,0,0.2)', padding: '0.2rem 0.6rem', borderRadius: 100 }}>
            {user?.client?.name || 'Beaver Solutions'}
          </span>
          <button className="btn btn-ghost" style={{ padding: '0.25rem' }}>
            <Bell size={18} />
          </button>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: '1.5rem', overflowY: 'auto' }}>
          <Outlet />
        </main>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-sidebar { display: block !important; }
          #hamburger { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
