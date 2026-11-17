import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi, useAsync, type Paged } from 'pg-core';
import type { Property } from './types';

interface PropertyCtx {
  properties: Property[];
  current: Property | null;
  setCurrentId: (id: string) => void;
  reload: () => void;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<PropertyCtx | null>(null);
const KEY = 'pg-owner-property';

export function PropertyProvider({ children }: { children: ReactNode }) {
  const client = useApi();
  const state = useAsync(() => client.get<Paged<Property>>('/api/owner/properties?pageSize=100'), []);
  const [currentId, setCurrentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const properties = useMemo(() => state.data?.items ?? [], [state.data]);
  const current = properties.find((p) => p.id === currentId) ?? properties[0] ?? null;

  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);

  const value: PropertyCtx = {
    properties,
    current,
    setCurrentId: (id) => {
      setCurrentId(id);
      try {
        localStorage.setItem(KEY, id);
      } catch {
        /* ignore */
      }
    },
    reload: state.reload,
    loading: state.loading,
    error: state.error,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProperty() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProperty outside PropertyProvider');
  return v;
}

export function PropertySwitcher() {
  const { properties, current, setCurrentId } = useProperty();
  if (properties.length < 2) return current ? <span className="faint" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.name}</span> : null;
  return (
    <select className="input" style={{ minHeight: 40, width: 'auto', maxWidth: 190, fontSize: 14 }} value={current?.id} onChange={(e) => setCurrentId(e.target.value)} aria-label="Property">
      {properties.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}
