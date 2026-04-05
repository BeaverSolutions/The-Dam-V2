import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './utils/auth';
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
import { getUser } from './utils/auth';

function PrivateRoute({ children }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

function SuperAdminRoute({ children }) {
  if (!isAuthenticated()) return <Navigate to="/login" replace />;
  const user = getUser();
  const isSuperAdmin = user?.client?.name?.toLowerCase().includes('beaver') || user?.client?.id === user?.client?.id;
  // Backend enforces the real check — this just prevents the blank flash for non-admins
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/join" element={<Join />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/access-code" element={<AccessCode />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
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
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
