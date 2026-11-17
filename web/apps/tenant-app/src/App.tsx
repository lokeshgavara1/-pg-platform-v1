import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, AuthProvider, createClient, LoginScreen, useAuth, type NavItem } from 'pg-core';
import { HomePage } from './pages/Home';
import { JoinPage } from './pages/Join';
import { DuesPage } from './pages/Dues';
import { KycPage } from './pages/Kyc';
import { AgreementPage } from './pages/Agreement';
import { ComplaintsPage } from './pages/Complaints';
import { NoticesPage } from './pages/Notices';
import { MoveOutPage } from './pages/MoveOut';
import { MePage } from './pages/Me';

const client = createClient('tenant');

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: '⌂', end: true },
  { to: '/dues', label: 'Pay', icon: '₹' },
  { to: '/complaints', label: 'Help', icon: '⚑' },
  { to: '/notices', label: 'Notices', icon: '✉' },
  { to: '/me', label: 'Me', icon: '☺' },
];

function Authed() {
  const { session } = useAuth();
  if (!session) return <LoginScreen title="Your PG, in your pocket" tagline="Pay rent by UPI, raise complaints, and keep your agreement and receipts safe." />;
  return (
    <BrowserRouter>
      <AppShell appLabel="My PG" nav={NAV}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join" element={<JoinPage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/dues" element={<DuesPage />} />
          <Route path="/kyc" element={<KycPage />} />
          <Route path="/agreement" element={<AgreementPage />} />
          <Route path="/complaints" element={<ComplaintsPage />} />
          <Route path="/notices" element={<NoticesPage />} />
          <Route path="/move-out" element={<MoveOutPage />} />
          <Route path="/me" element={<MePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <AuthProvider app="tenant" client={client}>
      <Authed />
    </AuthProvider>
  );
}
