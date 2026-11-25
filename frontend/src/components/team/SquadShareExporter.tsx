"use client";

import React, { useState } from "react";
import QRCode from "qrcode";
import type { LocalSquadPlayer } from "@/store/teamStore";

interface Props { players: LocalSquadPlayer[]; squadName: string; managerHandle: string; }

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);

export function SquadShareExporter({ players, squadName, managerHandle }: Props) {
  const [busy, setBusy] = useState(false);
  const starters = players.filter((player) => player.isStarter);

  async function buildSvg(): Promise<string> {
    const shareUrl = `${window.location.origin}/team`;
    const qr = await QRCode.toDataURL(shareUrl, { width: 128, margin: 1, color: { dark: "#111827", light: "#ffffff" } });
    const groups = ["FWD", "MID", "DEF", "GKP"].map((position) => starters.filter((entry) => entry.player.position === position));
    const yByPosition: Record<string, number> = { FWD: 170, MID: 330, DEF: 500, GKP: 650 };
    const nodes = groups.flatMap((group) => group.map((entry, index) => {
      const x = ((index + 1) * 800) / (group.length + 1);
      const y = yByPosition[entry.player.position];
      const captain = entry.isCaptain ? " (C)" : entry.isViceCaptain ? " (V)" : "";
      return `<g transform="translate(${x} ${y})"><circle r="34" fill="#10b981" stroke="#d1fae5" stroke-width="4"/><text y="5" text-anchor="middle" font-family="Arial" font-weight="800" font-size="15" fill="#052e16">${entry.player.position}</text><rect x="-68" y="42" width="136" height="34" rx="6" fill="#111827"/><text y="64" text-anchor="middle" font-family="Arial" font-weight="700" font-size="15" fill="white">${escapeXml(entry.player.displayName + captain)}</text></g>`;
    })).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="900" viewBox="0 0 800 900"><rect width="800" height="900" fill="#071a12"/><rect x="45" y="105" width="710" height="650" rx="20" fill="#12633f" stroke="#d1fae5" stroke-width="4"/><path d="M45 430H755M310 105V190H490V105M310 755V670H490V755" fill="none" stroke="#d1fae5" stroke-width="3" opacity=".7"/><circle cx="400" cy="430" r="75" fill="none" stroke="#d1fae5" stroke-width="3" opacity=".7"/><text x="48" y="58" font-family="Arial" font-size="30" font-weight="900" fill="white">${escapeXml(squadName)}</text><text x="48" y="86" font-family="Arial" font-size="16" fill="#a7f3d0">@${escapeXml(managerHandle)} · FantasyXI</text>${nodes}<rect x="45" y="790" width="710" height="80" rx="12" fill="#ffffff"/><image href="${qr}" x="55" y="797" width="66" height="66"/><text x="140" y="828" font-family="Arial" font-size="18" font-weight="800" fill="#111827">Build your FantasyXI</text><text x="140" y="852" font-family="Arial" font-size="14" fill="#475569">${escapeXml(shareUrl)}</text><text x="744" y="850" text-anchor="end" font-family="Arial" font-size="20" font-weight="900" fill="#37003c">FANTASYXI</text></svg>`;
  }

  async function toPngBlob(svg: string): Promise<Blob> {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = url; });
      const canvas = document.createElement("canvas");
      canvas.width = 1600; canvas.height = 1800;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png"));
    } finally { URL.revokeObjectURL(url); }
  }

  async function download(format: "svg" | "png") {
    if (starters.length !== 11) return;
    setBusy(true);
    try {
      const svg = await buildSvg();
      const blob = format === "svg" ? new Blob([svg], { type: "image/svg+xml" }) : await toPngBlob(svg);
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${squadName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "fantasyxi"}.${format}`; link.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  }

  async function copyImage() {
    if (starters.length !== 11 || !navigator.clipboard || typeof ClipboardItem === "undefined") return;
    setBusy(true);
    try { const blob = await toPngBlob(await buildSvg()); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); }
    finally { setBusy(false); }
  }

  return <div className="flex flex-wrap items-center gap-2" aria-label="Share squad graphic">
    <button type="button" disabled={busy || starters.length !== 11} onClick={copyImage} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold disabled:opacity-40">Copy image</button>
    <button type="button" disabled={busy || starters.length !== 11} onClick={() => download("png")} className="px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold disabled:opacity-40">Download PNG</button>
    <button type="button" disabled={busy || starters.length !== 11} onClick={() => download("svg")} className="px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold disabled:opacity-40">Download SVG</button>
  </div>;
}
