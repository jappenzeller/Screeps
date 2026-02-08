import { useState } from 'react';
import type { CreepDetail } from '../../types/colony';
import { ROLE_COLORS, BODY_PART_COLORS, BODY_PART_SHORT } from '../../utils/constants';

interface CreepRosterProps {
  creeps: CreepDetail[] | null;
  byRole: Record<string, number>;
  loading?: boolean;
  error?: Error | null;
}

export function CreepRoster({ creeps, byRole, loading, error }: CreepRosterProps) {
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-[#222] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#331111] border border-[#ff4444] rounded-lg p-4">
        <p className="text-[#ff4444]">Failed to load creeps: {error.message}</p>
      </div>
    );
  }

  const roles = Object.entries(byRole).sort(([, a], [, b]) => b - a);

  if (roles.length === 0) {
    return <p className="text-[#888]">No creeps in this colony</p>;
  }

  const toggleRole = (role: string) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
  };

  const creepsByRole = creeps?.reduce((acc, c) => {
    const role = c.role.toUpperCase();
    if (!acc[role]) acc[role] = [];
    acc[role].push(c);
    return acc;
  }, {} as Record<string, CreepDetail[]>) ?? {};

  return (
    <div className="space-y-2">
      {roles.map(([role, count]) => {
        const roleCreeps = creepsByRole[role] ?? [];
        const avgTtl = roleCreeps.length > 0
          ? Math.round(roleCreeps.reduce((sum, c) => sum + (c.ticksToLive ?? 0), 0) / roleCreeps.length)
          : 0;
        const ttlPercent = (avgTtl / 1500) * 100;
        const isExpanded = expandedRoles.has(role);
        const roleColor = ROLE_COLORS[role] ?? '#888888';

        return (
          <div key={role} className="bg-[#1a1a1a] border border-[#333] rounded-lg overflow-hidden">
            {/* Role Header */}
            <button
              type="button"
              onClick={() => toggleRole(role)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#222] transition-colors"
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: roleColor }}
                />
                <span className="font-medium text-[#eee]">{role}</span>
                <span className="text-[#888]">({count})</span>
              </div>
              <div className="flex items-center gap-4">
                {avgTtl > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-1.5 bg-[#333] rounded-full overflow-hidden">
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${ttlPercent}%`,
                          backgroundColor: avgTtl > 500 ? '#00ff88' : avgTtl > 200 ? '#ffcc00' : '#ff4444',
                        }}
                      />
                    </div>
                    <span className="text-xs text-[#888]">TTL: {avgTtl}</span>
                  </div>
                )}
                <span className="text-[#666]">{isExpanded ? '▼' : '▶'}</span>
              </div>
            </button>

            {/* Expanded Creep List */}
            {isExpanded && roleCreeps.length > 0 && (
              <div className="border-t border-[#333] divide-y divide-[#333]">
                {roleCreeps.map((creep) => (
                  <CreepRow key={creep.name} creep={creep} />
                ))}
              </div>
            )}
            {isExpanded && roleCreeps.length === 0 && (
              <div className="px-4 py-2 text-sm text-[#666] border-t border-[#333]">
                No detailed creep data available
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CreepRow({ creep }: { creep: CreepDetail }) {
  const ttlColor = creep.ticksToLive > 500 ? '#00ff88' : creep.ticksToLive > 200 ? '#ffcc00' : '#ff4444';

  return (
    <div className="px-4 py-2 flex items-center justify-between text-sm hover:bg-[#222]">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[#ccc] truncate max-w-[140px]" title={creep.name}>
          {creep.name}
        </span>
        <BodyParts body={creep.body} />
      </div>
      <div className="flex items-center gap-4 text-xs shrink-0">
        <span style={{ color: ttlColor }}>TTL: {creep.ticksToLive}</span>
        <span className="text-[#888]">
          ({creep.pos.x}, {creep.pos.y})
        </span>
        {creep.state && (
          <span className="text-[#4488ff]">{creep.state}</span>
        )}
        {creep.spawning && (
          <span className="text-[#ffcc00]">spawning</span>
        )}
      </div>
    </div>
  );
}

function BodyParts({ body }: { body: string[] }) {
  // Count each part type
  const counts: Record<string, number> = {};
  for (const part of body) {
    const p = part.toLowerCase();
    counts[p] = (counts[p] ?? 0) + 1;
  }

  return (
    <div className="flex gap-0.5">
      {Object.entries(counts).map(([part, count]) => {
        const color = BODY_PART_COLORS[part] ?? '#888';
        const short = BODY_PART_SHORT[part] ?? part[0].toUpperCase();
        return (
          <span
            key={part}
            className="text-xs font-mono px-1 rounded"
            style={{ backgroundColor: color + '33', color }}
            title={`${part} x${count}`}
          >
            {short}{count > 1 ? count : ''}
          </span>
        );
      })}
    </div>
  );
}
