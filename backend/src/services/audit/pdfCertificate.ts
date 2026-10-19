/**
 * Pure Node.js PDF 1.4 Generator for Cryptographic Audit Certificates.
 * Produces clean, standards-compliant, standalone PDF documents without external dependencies.
 */

export interface PdfCertificateData {
  title: string;
  leagueId: string;
  leagueName: string;
  gameweek: number | string;
  eventCount: number;
  merkleRoot: string;
  sealHash: string;
  generatedAt: string;
  verificationInstructions: string[];
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function generateAuditCertificatePdf(data: PdfCertificateData): Buffer {
  // Construct page stream content
  const lines: string[] = [];

  // Coordinate system: 612 x 792 (Standard US Letter), (0,0) is bottom-left
  // Draw header banner
  lines.push("0.1 0.15 0.3 rg"); // dark navy fill
  lines.push("36 710 540 50 re"); // rectangle: x y width height
  lines.push("f");

  // Title in header
  lines.push("1 1 1 rg"); // white text
  lines.push("BT");
  lines.push("/F1 18 Tf");
  lines.push("50 728 Td");
  lines.push(`(${escapePdfText("FANTASY XI - LEAGUE AUDIT INTEGRITY CERTIFICATE")}) Tj`);
  lines.push("ET");

  // Subtitle / Intro
  lines.push("0.2 0.2 0.2 rg"); // dark gray
  lines.push("BT");
  lines.push("/F1 11 Tf");
  lines.push("50 675 Td");
  lines.push(`(${escapePdfText("Official cryptographic proof of immutable ledger state and gameweek event integrity.")}) Tj`);
  lines.push("ET");

  // Section 1: League Metadata Box
  lines.push("0.95 0.95 0.97 rg"); // light gray fill
  lines.push("36 540 540 115 re");
  lines.push("f");
  lines.push("0.8 0.8 0.85 RG"); // border stroke
  lines.push("1 w");
  lines.push("36 540 540 115 re");
  lines.push("S");

  lines.push("0.1 0.1 0.1 rg");
  lines.push("BT");
  lines.push("/F1 12 Tf");
  lines.push("50 630 Td");
  lines.push(`(${escapePdfText("LEAGUE IDENTIFICATION & SCOPE")}) Tj`);
  lines.push("/F2 10 Tf");
  lines.push("0 -20 Td");
  lines.push(`(${escapePdfText(`League Name:      ${data.leagueName}`)}) Tj`);
  lines.push("0 -16 Td");
  lines.push(`(${escapePdfText(`League ID:        ${data.leagueId}`)}) Tj`);
  lines.push("0 -16 Td");
  lines.push(`(${escapePdfText(`Audited Gameweek: ${data.gameweek}`)}) Tj`);
  lines.push("0 -16 Td");
  lines.push(`(${escapePdfText(`Journal Events:   ${data.eventCount} sequential actions sealed`)}) Tj`);
  lines.push("ET");

  // Section 2: Cryptographic Seal Box
  lines.push("0.92 0.96 0.94 rg"); // light mint/green fill
  lines.push("36 385 540 135 re");
  lines.push("f");
  lines.push("0.3 0.6 0.4 RG"); // green border stroke
  lines.push("1.5 w");
  lines.push("36 385 540 135 re");
  lines.push("S");

  lines.push("0.1 0.35 0.2 rg");
  lines.push("BT");
  lines.push("/F1 12 Tf");
  lines.push("50 495 Td");
  lines.push(`(${escapePdfText("CRYPTOGRAPHIC INTEGRITY SEAL (SHA-256 MERKLE ROOT)")}) Tj`);
  lines.push("0.15 0.15 0.15 rg");
  lines.push("/F2 9 Tf");
  lines.push("0 -20 Td");
  lines.push(`(${escapePdfText("Merkle Root Hash:")}) Tj`);
  lines.push("0 -14 Td");
  lines.push(`(${escapePdfText(data.merkleRoot)}) Tj`);
  lines.push("0 -20 Td");
  lines.push(`(${escapePdfText("Seal Hash:")}) Tj`);
  lines.push("0 -14 Td");
  lines.push(`(${escapePdfText(data.sealHash)}) Tj`);
  lines.push("0 -20 Td");
  lines.push(`(${escapePdfText(`Sealed At (UTC):  ${data.generatedAt}`)}) Tj`);
  lines.push("ET");

  // Section 3: Verification Instructions
  lines.push("0.98 0.98 0.98 rg");
  lines.push("36 120 540 245 re");
  lines.push("f");
  lines.push("0.85 0.85 0.85 RG");
  lines.push("1 w");
  lines.push("36 120 540 245 re");
  lines.push("S");

  lines.push("0.1 0.1 0.1 rg");
  lines.push("BT");
  lines.push("/F1 11 Tf");
  lines.push("50 338 Td");
  lines.push(`(${escapePdfText("INDEPENDENT AUDIT VERIFICATION INSTRUCTIONS")}) Tj`);
  lines.push("/F2 8.5 Tf");
  lines.push("0 -18 Td");

  let yOffset = 0;
  for (const step of data.verificationInstructions) {
    lines.push(`(${escapePdfText(step)}) Tj`);
    lines.push("0 -14 Td");
    yOffset -= 14;
  }
  lines.push("ET");

  // Footer
  lines.push("0.5 0.5 0.5 rg");
  lines.push("BT");
  lines.push("/F2 8 Tf");
  lines.push("50 50 Td");
  lines.push(`(${escapePdfText("Fantasy XI Cryptographic Audit Engine • Deterministic SHA-256 Merkle Provenance")}) Tj`);
  lines.push("ET");

  const streamContent = lines.join("\n") + "\n";
  const streamLength = Buffer.byteLength(streamContent, "utf8");

  // PDF Objects
  const objects: string[] = [];

  // 1 0 obj: Catalog
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  // 2 0 obj: Pages
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);

  // 3 0 obj: Page
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n`
  );

  // 4 0 obj: Stream Contents
  objects.push(
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}endstream\nendobj\n`
  );

  // 5 0 obj: Font Bold
  objects.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`);

  // 6 0 obj: Font Regular/Mono
  objects.push(`6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n`);

  // Construct PDF binary buffer with exact xref table
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += objects[i];
  }

  const startxref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (const offset of offsets) {
    const padded = offset.toString().padStart(10, "0");
    pdf += `${padded} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
}
