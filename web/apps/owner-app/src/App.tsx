import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, AuthProvider, createClient, LoginScreen, Spinner, useAuth, type NavItem } from 'pg-core';
import { PropertyProvider, PropertySwitcher, useProperty } from './property';
import { DashboardPage } from './pages/Dashboard';
import { BedsPage } from './pages/Beds';
import { TenantsPage } from './pages/Tenants';
import { AddTenantPage } from './pages/AddTenant';
import { TenantDetailPage } from './pages/TenantDetail';
import { RentPage } from './pages/Rent';
import { MorePage } from './pages/More';
import { BookingsPage } from './pages/Bookings';
import { KycPage } from './pages/Kyc';
import { ComplaintsPage } from './pages/Complaints';
import { NoticesPage } from './pages/Notices';
import { MoveOutsPage, MoveOutDetailPage } from './pages/MoveOuts';
import { VerificationPage } from './pages/Verification';
import { PropertiesPage, PropertyForm } from './pages/Properties';

const client = createClient('owner');

const OWNER_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: '◧', end: true },
  { to: '/beds', label: 'Beds', icon: '▦' },
  { to: '/tenants', label: 'Tenants', icon: '☺' },
  { to: '/rent', label: 'Rent', icon: '₹' },
  { to: '/more', label: 'More', icon: '☰' },
];
const STAFF_NAV: NavItem[] = [{ to: '/', label: 'Complaints', icon: '⚑', end: true }];

function OwnerRoutes() {
  const { properties, loading, error, reload } = useProperty();
  if (loading && properties.length === 0) return <Spinner />;
  if (error) return <div className="alert">{error}</div>;
  if (properties.length === 0) {
    return (
      <div className="stack reveal">
        <div className="page-head">
          <div>
            <div className="eyebrow">Welcome</div>
            <h1>Add your first PG</h1>
            <p className="muted">Start with the building. You’ll add rooms and beds next, then your current tenants.</p>
          </div>
        </div>
        <PropertyForm onSaved={reload} />
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/beds" element={<BedsPage />} />
      <Route path="/tenants" element={<TenantsPage />} />
      <Route path="/tenants/new" element={<AddTenantPage />} />
      <Route path="/tenancies/:id" element={<TenantDetailPage />} />
      <Route path="/rent" element={<RentPage />} />
      <Route path="/more" element={<MorePage />} />
      <Route path="/bookings" element={<BookingsPage />} />
      <Route path="/kyc" element={<KycPage />} />
      <Route path="/complaints" element={<ComplaintsPage />} />
      <Route path="/notices" element={<NoticesPage />} />
      <Route path="/move-outs" element={<MoveOutsPage />} />
      <Route path="/move-outs/:id" element={<MoveOutDetailPage />} />
      <Route path="/verification" element={<VerificationPage />} />
      <Route path="/properties" element={<PropertiesPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Authed() {
  const { session } = useAuth();
  if (!session) return <LoginScreen title="Run your PG without the notebook" tagline="Beds, rent, tenants and paperwork — in one place." />;
  const staff = session.user.role === 'STAFF';
  return (
    <BrowserRouter>
      <PropertyProvider>
        <AppShell appLabel={staff ? 'PG Staff' : 'PG Owner'} nav={staff ? STAFF_NAV : OWNER_NAV} right={staff ? null : <PropertySwitcher />}>
          {staff ? (
            <Routes>
              <Route path="*" element={<ComplaintsPage staff />} />
            </Routes>
          ) : (
            <OwnerRoutes />
          )}
        </AppShell>
      </PropertyProvider>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <AuthProvider app="owner" client={client}>
      <Authed />
    </AuthProvider>
  );
}
