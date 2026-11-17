import type { Bed, Room } from '../types';
import { formatINR } from 'pg-core';

const STATE_CLASS = { VACANT: 'vacant', RESERVED: 'reserved', OCCUPIED: 'occupied', INACTIVE: 'inactive' } as const;
const STATE_LABEL = { VACANT: 'Vacant', RESERVED: 'Reserved', OCCUPIED: 'Occupied', INACTIVE: 'Inactive' } as const;

/** Occupancy grid: each room is a "key rack"; each bed is a tag coloured by its derived status. */
export function BedGrid({ rooms, onBed, onRoom }: { rooms: Room[]; onBed: (room: Room, bed: Bed) => void; onRoom?: (room: Room) => void }) {
  return (
    <div className="rack">
      {rooms.map((room) => {
        const occupied = room.beds.filter((b) => b.occupancy?.status === 'OCCUPIED').length;
        return (
          <section key={room.id} className="card room-card" aria-label={`Room ${room.name}`}>
            <div className="row between">
              <div>
                <div className="room-name">{room.name}</div>
                <div className="faint">
                  {room.sharingType}-sharing · {formatINR(room.rentPaise)}/bed · floor {room.floor}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className="badge">{occupied}/{room.beds.filter((b) => b.occupancy?.status !== 'INACTIVE').length}</span>
                {onRoom && (
                  <button className="icon-btn" aria-label={`Edit room ${room.name}`} onClick={() => onRoom(room)}>✎</button>
                )}
              </div>
            </div>
            <div className="beds">
              {room.beds.map((bed) => {
                const st = bed.occupancy?.status ?? 'VACANT';
                return (
                  <button
                    key={bed.id}
                    className={`bed ${STATE_CLASS[st]}`}
                    data-testid={`bed-${room.name}-${bed.label}`}
                    data-status={st}
                    aria-label={`Bed ${room.name}-${bed.label}: ${STATE_LABEL[st]}${bed.occupancy?.tenantName ? `, ${bed.occupancy.tenantName}` : ''}`}
                    onClick={() => onBed(room, bed)}
                  >
                    <span className="lbl">{bed.label}</span>
                    <span className="who">{bed.occupancy?.tenantName?.split(' ')[0] ?? (st === 'RESERVED' ? 'Hold' : st === 'VACANT' ? 'Free' : '')}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function BedLegend() {
  return (
    <div className="legend" aria-hidden>
      <span><i className="vacant" />Vacant</span>
      <span><i className="reserved" />Reserved</span>
      <span><i className="occupied" />Occupied</span>
    </div>
  );
}
