import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BedGrid } from './BedGrid';
import type { Room } from '../types';

afterEach(cleanup);

const rooms: Room[] = [
  {
    id: 'r1',
    name: '101',
    floor: 1,
    sharingType: 4,
    rentPaise: 850000,
    status: 'ACTIVE',
    beds: [
      { id: 'b1', label: 'A', status: 'ACTIVE', occupancy: { status: 'OCCUPIED', tenancyId: 't1', tenantName: 'Arjun Mehta' } },
      { id: 'b2', label: 'B', status: 'ACTIVE', occupancy: { status: 'RESERVED', bookingId: 'k1', bookingStatus: 'PAID' } },
      { id: 'b3', label: 'C', status: 'ACTIVE', occupancy: { status: 'VACANT' } },
      { id: 'b4', label: 'D', status: 'INACTIVE', occupancy: { status: 'INACTIVE' } },
    ],
  },
];

function renderGrid(onBed = vi.fn()) {
  render(
    <MemoryRouter>
      <BedGrid rooms={rooms} onBed={onBed} />
    </MemoryRouter>,
  );
  return onBed;
}

describe('BedGrid', () => {
  it('shows each bed with its derived status', () => {
    renderGrid();
    expect(screen.getByTestId('bed-101-A').dataset.status).toBe('OCCUPIED');
    expect(screen.getByTestId('bed-101-A').className).toContain('occupied');
    expect(screen.getByTestId('bed-101-B').className).toContain('reserved');
    expect(screen.getByTestId('bed-101-C').className).toContain('vacant');
    expect(screen.getByTestId('bed-101-D').className).toContain('inactive');
  });

  it('labels beds accessibly with the occupant name', () => {
    renderGrid();
    expect(screen.getByLabelText('Bed 101-A: Occupied, Arjun Mehta')).toBeTruthy();
    expect(screen.getByLabelText('Bed 101-C: Vacant')).toBeTruthy();
  });

  it('shows the room summary: occupied over usable beds and rent', () => {
    renderGrid();
    expect(screen.getByText('1/3')).toBeTruthy();
    expect(screen.getByText(/₹8,500\/bed/)).toBeTruthy();
  });

  it('calls onBed with the room and bed', () => {
    const onBed = renderGrid();
    fireEvent.click(screen.getByTestId('bed-101-C'));
    expect(onBed).toHaveBeenCalledWith(rooms[0], rooms[0].beds[2]);
  });
});
