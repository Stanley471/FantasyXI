import React from "react";

/** Skeleton placeholder shown via <Suspense fallback={<StandingsLoading />}> while standings load server-side. */
export function StandingsLoading() {
  const ROWS = 6;

  return (
    <div className="w-full overflow-x-auto animate-pulse" aria-busy="true" aria-label="Loading standings…">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="border-b border-pitch-border text-slate-400 uppercase font-semibold text-[11px] bg-slate-950/50">
            <th className="py-3 px-3 w-12 text-center">Rank</th>
            <th className="py-3 px-3">Manager &amp; Squad</th>
            <th className="py-3 px-3">Escrow Status</th>
            <th className="py-3 px-3 text-center">Best GW</th>
            <th className="py-3 px-3 text-right">Total Pts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {Array.from({ length: ROWS }).map((_, i) => (
            <tr key={i} className="hover:bg-slate-900/40 transition-colors">
              {/* Rank */}
              <td className="py-3 px-3 text-center">
                <div className="w-6 h-6 rounded-full bg-slate-800 mx-auto" />
              </td>

              {/* Manager & Squad */}
              <td className="py-3 px-3">
                <div className="h-3.5 bg-slate-800 rounded w-28 mb-1.5" />
                <div className="h-2.5 bg-slate-800/60 rounded w-20" />
              </td>

              {/* Escrow Status */}
              <td className="py-3 px-3">
                <div className="h-5 bg-slate-800 rounded-full w-20" />
              </td>

              {/* Best GW */}
              <td className="py-3 px-3 text-center">
                <div className="h-3 bg-slate-800 rounded w-12 mx-auto" />
              </td>

              {/* Total Pts */}
              <td className="py-3 px-3 text-right">
                <div className="h-4 bg-slate-800 rounded w-14 ml-auto" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
