import React, { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, GitBranch, MessageSquare, CheckCircle,
  Activity, Calendar, Users, MessageCircle, Settings, Menu, X, Bell, LogOut, Brain, ShieldCheck, Upload,
} from 'lucide-react';
import { clearToken, getUser } from '../utils/auth';
import { useApi } from '../hooks/useApi';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/pipeline', label: 'Pipeline', icon: GitBranch },
  { path: '/messages', label: 'Messages', icon: MessageSquare, rangerBadge: true },
  { path: '/approvals', label: 'Approvals', icon: CheckCircle, badge: true },
  { path: '/logs', label: 'Activity Log', icon: Activity },
  { path: '/calendar', label: 'Calendar', icon: Calendar },
  { path: '/team', label: 'The Crew', icon: Users },
  { path: '/chat', label: 'Director Chat', icon: MessageCircle },
  { path: '/memory', label: 'Memory', icon: Brain },
  { path: '/import', label: 'Import Leads', icon: Upload },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [rangerRejectedCount, setRangerRejectedCount] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const user = getUser();
  const { request } = useApi();
  // Super admin = Beaver Solutions admins only
  const isSuperAdmin = user?.role === 'admin' &&
    (user?.client?.slug === 'beaver-solutions' || user?.client?.name?.toLowerCase().includes('beaver'));

  useEffect(() => {
    const fetchCounts = () => {
      request('/approvals?status=pending&perPage=1')
        .then(res => setPendingCount(res?.meta?.total || 0))
        .catch(() => {});
      request('/messages?status=ranger_rejected&perPage=1')
        .then(res => {
          const total = res?.meta?.total || 0;
          // Only show badge for rejections that appeared after the user last visited /messages
          const lastSeen = parseInt(localStorage.getItem('messages_last_seen_rejected') || '0', 10);
          setRangerRejectedCount(Math.max(0, total - lastSeen));
        })
        .catch(() => {});
    };
    fetchCounts();
    const interval = setInterval(fetchCounts, 10000);
    return () => clearInterval(interval);
  }, [location.pathname]);

  // Clear the Messages badge when user visits the Messages page
  useEffect(() => {
    if (location.pathname.startsWith('/messages')) {
      request('/messages?status=ranger_rejected&perPage=1')
        .then(res => {
          const total = res?.meta?.total || 0;
          localStorage.setItem('messages_last_seen_rejected', String(total));
          setRangerRejectedCount(0);
        })
        .catch(() => {});
    }
  }, [location.pathname]);

  const handleLogout = async () => {
    try { await request('/auth/logout', { method: 'POST' }); } catch {}
    clearToken();
    navigate('/login');
  };

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const sidebar = (
    <nav className="sidebar-nav" style={{
      width: 'var(--sidebar-width)',
      background: 'var(--panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      position: 'fixed',
      left: 0, top: 0, bottom: 0,
      zIndex: 100,
      transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
      transition: 'transform 0.25s ease',
    }}>
      {/* Logo */}
      <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <img src="/assets/logo-new.png" alt="BeavR Dam" style={{ width: 36, height: 36, objectFit: 'contain', flexShrink: 0 }} />
        <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--brand)', fontFamily: "'Nunito', 'Poppins', sans-serif", letterSpacing: '-0.2px' }}>
          {(() => {
            const isBeaverSolutions = user?.client?.name?.toLowerCase().includes('beaver') || (!user?.client?.name && user?.role === 'admin');
            return isBeaverSolutions ? 'BeavR Dam' : (user?.client?.name || 'BeavR Dam');
          })()}
        </div>
      </div>

      {/* Nav items */}
      <div style={{ flex: 1, padding: '0.75rem 0', overflowY: 'auto' }}>
        {navItems.map(({ path, label, icon: Icon, badge, rangerBadge }) => (
          <button
            key={path}
            onClick={() => { navigate(path); setSidebarOpen(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.625rem 1rem',
              background: isActive(path) ? 'rgba(255,106,0,0.08)' : 'transparent',
              color: isActive(path) ? 'var(--brand)' : 'var(--text-muted)',
              border: 'none',
              borderLeft: isActive(path) ? '3px solid var(--brand)' : '3px solid transparent',
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
            {rangerBadge && rangerRejectedCount > 0 && (
              <span className="nav-badge" style={{ background: 'var(--orange)', boxShadow: '0 0 6px var(--orange)' }} title="Ranger rejected — needs manual review">
                {rangerRejectedCount > 99 ? '99+' : rangerRejectedCount}
              </span>
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
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'rgba(255,106,0,0.08)', border: '1px solid rgba(255,106,0,0.2)', padding: '0.2rem 0.6rem', borderRadius: 100 }}>
            {user?.client?.name || 'Beaver Solutions'}
          </span>
          <button className="btn btn-ghost" style={{ padding: '0.25rem' }}>
            <Bell size={18} />
          </button>
        </header>

        {/* Page content */}
        <main className="main-content" style={{ flex: 1, padding: '1.5rem', overflowY: 'auto' }}>
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
