import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated, clearToken, setUser, getUser } from './utils/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import VerifyEmail from './pages/VerifyEmail';
import AccessCode from './pages/AccessCode';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Pipeline from './pages/Pipeline';
import Messages from './pages/Messages';
import Approvals from './pages/Approvals';
import Logs from './pages/Logs';
import Calendar from './pages/Calendar';
import Team from './pages/Team';
import Chat from './pages/Chat';
import Memory from './pages/Memory';
import Import from './pages/Import';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import Join from './pages/Join';

function PrivateRoute({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

// Super-admin gate: the /admin panel manages ALL tenants. Only the
// Beaver Solutions super-admin may reach it. Mirrors Layout.jsx's
// isSuperAdmin — a regular client user typing /admin lands back on /.
function AdminRoute({ children }) {
  const user = getUser();
  const isSuperAdmin = user?.role === 'admin' &&
    (user?.client?.slug === 'beaver-solutions' || user?.client?.name?.toLowerCase().includes('beaver'));
  return isSuperAdmin ? children : <Navigate to="/" replace />;
}

function AuthValidator({ children }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!isAuthenticated()) { setChecked(true); return; }
    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => {
        if (res.status === 401) { clearToken(); window.location.href = '/login'; }
        else return res.json().then(d => { if (d?.data) setUser(d.data); });
      })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);
  if (!checked) return null;
  return children;
}

export default function App() {
  return (
    <AuthValidator>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/join" element={<Join />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/access-code" element={<AccessCode />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="messages" element={<Messages />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="logs" element={<Logs />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="team" element={<Team />} />
          <Route path="chat" element={<Chat />} />
          <Route path="memory" element={<Memory />} />
          <Route path="import" element={<Import />} />
          <Route path="settings" element={<Settings />} />
          <Route path="admin" element={<AdminRoute><Admin /></AdminRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthValidator>
  );
}
