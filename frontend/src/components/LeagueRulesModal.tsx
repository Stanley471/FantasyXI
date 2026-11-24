import React, { useEffect, useRef } from 'react';

interface PrizeBreakdown {
  first: number;
  second: number;
  third: number;
  platformFee: number;
}

interface LeagueRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  leagueName: string;
  entryFee: number;
  participantCount: number;
  currency: 'USD' | 'crypto';
  currencySymbol: string;
  tokenDecimals?: number;
  exchangeRate?: number; // USD per unit of crypto
  tieBreakerRules: string[];
  deadlineRuleText: string;
  platformFeePercentage?: number;
  prizePercentages?: { first: number; second: number; third: number };
}

/**
 * Pure calculation functions for prize math using integer arithmetic (cents/smallest unit)
 */
export function calculatePrizeBreakdown(
  entryFee: number, // in smallest unit (cents for USD)
  participantCount: number,
  prizePercentages = { first: 60, second: 30, third: 10 },
  platformFeePercentage = 5
): PrizeBreakdown {
  // Gross pool in smallest unit
  const grossPool = entryFee * participantCount;

  // Platform fee (5% of gross)
  const platformFee = Math.floor((grossPool * platformFeePercentage) / 100);

  // Net distributable (after fee)
  const netDistributable = grossPool - platformFee;

  // Prize split (60/30/10 of net)
  let first = Math.floor((netDistributable * prizePercentages.first) / 100);
  let second = Math.floor((netDistributable * prizePercentages.second) / 100);
  let third = Math.floor((netDistributable * prizePercentages.third) / 100);

  // Assign any rounding remainder to first place
  const distributed = first + second + third + platformFee;
  const remainder = grossPool - distributed;
  first += remainder;

  return { first, second, third, platformFee };
}

/**
 * Format amount in cents/smallest units to display string
 */
function formatCurrency(amountInCents: number, symbol: string, decimals = 2): string {
  const amountInDollars = amountInCents / Math.pow(10, decimals);
  return `${symbol}${amountInDollars.toFixed(decimals)}`;
}

/**
 * Convert amount to crypto if exchange rate provided
 */
function convertToCrypto(
  amountInCents: number,
  exchangeRate?: number,
  tokenSymbol?: string,
  tokenDecimals = 8
): string | null {
  if (!exchangeRate || !tokenSymbol) return null;
  const amountInUSD = amountInCents / 100;
  const amountInCrypto = amountInUSD / exchangeRate;
  return `${tokenSymbol}${amountInCrypto.toFixed(tokenDecimals)}`.replace(/\.?0+$/, '');
}

export const LeagueRulesModal: React.FC<LeagueRulesModalProps> = ({
  isOpen,
  onClose,
  leagueName,
  entryFee,
  participantCount,
  currency,
  currencySymbol,
  tokenDecimals = 8,
  exchangeRate,
  tieBreakerRules,
  deadlineRuleText,
  platformFeePercentage = 5,
  prizePercentages = { first: 60, second: 30, third: 10 },
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.showModal();
      // Focus first focusable element
      const firstFocusable = dialogRef.current.querySelector(
        'button, [href], input, select, textarea, [tabindex]'
      ) as HTMLElement;
      if (firstFocusable) firstFocusable.focus();

      // Prevent background scroll
      document.body.style.overflow = 'hidden';

      // Respect prefers-reduced-motion
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!prefersReducedMotion) {
        dialogRef.current.classList.add('modal-open');
      }

      return () => {
        document.body.style.overflow = 'auto';
      };
    }
  }, [isOpen]);

  const handleClose = () => {
    if (dialogRef.current) {
      dialogRef.current.close();
    }
    onClose();
    // Return focus to trigger
    triggerRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      handleClose();
    }
  };

  if (!isOpen) return null;

  // Convert entry fee to cents if needed (assume already in cents)
  const entryFeeInCents = entryFee;
  const prizes = calculatePrizeBreakdown(entryFeeInCents, participantCount, prizePercentages, platformFeePercentage);
  const grossPoolInCents = entryFeeInCents * participantCount;

  const displayFirstPrize = formatCurrency(prizes.first, currencySymbol);
  const displaySecondPrize = formatCurrency(prizes.second, currencySymbol);
  const displayThirdPrize = formatCurrency(prizes.third, currencySymbol);
  const displayFee = formatCurrency(prizes.platformFee, currencySymbol);
  const displayGrossPool = formatCurrency(grossPoolInCents, currencySymbol);

  const cryptoFirstPrize = exchangeRate ? convertToCrypto(prizes.first, exchangeRate, 'XLM', tokenDecimals) : null;
  const cryptoSecondPrize = exchangeRate ? convertToCrypto(prizes.second, exchangeRate, 'XLM', tokenDecimals) : null;
  const cryptoThirdPrize = exchangeRate ? convertToCrypto(prizes.third, exchangeRate, 'XLM', tokenDecimals) : null;
  const cryptoFee = exchangeRate ? convertToCrypto(prizes.platformFee, exchangeRate, 'XLM', tokenDecimals) : null;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="league-rules-title"
      className="modal"
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="league-rules-title" className="modal-title">
            {leagueName} — Rules & Payouts
          </h2>
          <button
            aria-label="Close rules modal"
            onClick={handleClose}
            className="modal-close-btn"
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {/* Competition Structure */}
          <section className="rules-section" aria-labelledby="structure-heading">
            <h3 id="structure-heading" className="section-heading">
              Competition Structure
            </h3>
            <dl className="info-list">
              <div>
                <dt>Entry Fee</dt>
                <dd>
                  {displayFirstPrize}
                  {cryptoFirstPrize && <span className="crypto-amount"> ({cryptoFirstPrize})</span>}
                </dd>
              </div>
              <div>
                <dt>Total Participants</dt>
                <dd>{participantCount}</dd>
              </div>
              <div>
                <dt>Total Prize Pool (Gross)</dt>
                <dd>
                  {displayGrossPool}
                  {exchangeRate && <span className="crypto-amount"> (est.)</span>}
                </dd>
              </div>
            </dl>
          </section>

          {/* Prize Breakdown */}
          <section className="rules-section" aria-labelledby="prize-heading">
            <h3 id="prize-heading" className="section-heading">
              Prize Distribution
            </h3>

            {/* Stacked bar visualization */}
            <div className="prize-bar-container">
              <div className="prize-bar">
                <div
                  className="prize-segment first"
                  style={{ width: `${prizePercentages.first}%` }}
                  aria-label={`1st place: ${prizePercentages.first}%`}
                >
                  <span className="segment-label">1st</span>
                </div>
                <div
                  className="prize-segment second"
                  style={{ width: `${prizePercentages.second}%` }}
                  aria-label={`2nd place: ${prizePercentages.second}%`}
                >
                  <span className="segment-label">2nd</span>
                </div>
                <div
                  className="prize-segment third"
                  style={{ width: `${prizePercentages.third}%` }}
                  aria-label={`3rd place: ${prizePercentages.third}%`}
                >
                  <span className="segment-label">3rd</span>
                </div>
                <div
                  className="prize-segment fee"
                  style={{ width: `${platformFeePercentage}%` }}
                  aria-label={`Platform fee: ${platformFeePercentage}%`}
                >
                  <span className="segment-label">Fee</span>
                </div>
              </div>
            </div>

            {/* Prize table */}
            <table className="prize-table" role="table">
              <thead>
                <tr>
                  <th scope="col">Place</th>
                  <th scope="col">Percentage</th>
                  <th scope="col">Amount (USD)</th>
                  {exchangeRate && <th scope="col">Amount (Crypto)</th>}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1st Place</td>
                  <td>{prizePercentages.first}%</td>
                  <td>{displayFirstPrize}</td>
                  {exchangeRate && <td>{cryptoFirstPrize || 'N/A'}</td>}
                </tr>
                <tr>
                  <td>2nd Place</td>
                  <td>{prizePercentages.second}%</td>
                  <td>{displaySecondPrize}</td>
                  {exchangeRate && <td>{cryptoSecondPrize || 'N/A'}</td>}
                </tr>
                <tr>
                  <td>3rd Place</td>
                  <td>{prizePercentages.third}%</td>
                  <td>{displayThirdPrize}</td>
                  {exchangeRate && <td>{cryptoThirdPrize || 'N/A'}</td>}
                </tr>
                <tr className="fee-row">
                  <td>Platform Fee</td>
                  <td>{platformFeePercentage}%</td>
                  <td>{displayFee}</td>
                  {exchangeRate && <td>{cryptoFee || 'N/A'}</td>}
                </tr>
              </tbody>
            </table>

            {!exchangeRate && (
              <p className="note">
                <em>Crypto amounts unavailable (exchange rate not provided).</em>
              </p>
            )}

            <p className="note">
              <strong>Breakdown:</strong> Gross pool ({displayGrossPool}) minus platform fee ({displayFee}) = net
              distributable across 1st/2nd/3rd places. Any rounding remainder allocated to 1st place.
            </p>
          </section>

          {/* Tie-Breakers */}
          <section className="rules-section" aria-labelledby="tiebreaker-heading">
            <h3 id="tiebreaker-heading" className="section-heading">
              Tie-Breaker Rules
            </h3>
            {tieBreakerRules && tieBreakerRules.length > 0 ? (
              <ol className="rules-list">
                {tieBreakerRules.map((rule, idx) => (
                  <li key={idx}>{rule}</li>
                ))}
              </ol>
            ) : (
              <p className="placeholder">Not specified.</p>
            )}
          </section>

          {/* Deadline Rules */}
          <section className="rules-section" aria-labelledby="deadline-heading">
            <h3 id="deadline-heading" className="section-heading">
              Deadline & Lock Rules
            </h3>
            <div className="callout callout-info">
              {deadlineRuleText || <p className="placeholder">Not specified.</p>}
            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button onClick={handleClose} className="btn btn-primary" type="button">
            Close
          </button>
        </div>
      </div>

      <style jsx>{`
        .modal {
          all: revert;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1000;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 0;
          padding: 0;
          margin: 0;
          width: 100%;
          height: 100%;
        }

        .modal::backdrop {
          background: rgba(0, 0, 0, 0.5);
        }

        .modal[open] {
          display: flex;
        }

        .modal-content {
          background: white;
          border-radius: 8px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
          max-width: 600px;
          width: 90%;
          max-height: 90vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          border-bottom: 1px solid #e5e7eb;
          flex-shrink: 0;
        }

        .modal-title {
          margin: 0;
          font-size: 1.25rem;
          font-weight: 600;
          color: #1f2937;
        }

        .modal-close-btn {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #6b7280;
          padding: 4px 8px;
          border-radius: 4px;
        }

        .modal-close-btn:hover {
          background: #f3f4f6;
          color: #1f2937;
        }

        .modal-body {
          padding: 20px;
          flex: 1;
          overflow-y: auto;
        }

        .modal-footer {
          padding: 20px;
          border-top: 1px solid #e5e7eb;
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          flex-shrink: 0;
        }

        .rules-section {
          margin-bottom: 24px;
        }

        .section-heading {
          margin: 0 0 12px 0;
          font-size: 1rem;
          font-weight: 600;
          color: #374151;
        }

        .info-list {
          display: grid;
          gap: 12px;
          margin: 0;
          padding: 0;
        }

        .info-list > div {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 12px;
        }

        .info-list dt {
          font-weight: 500;
          color: #6b7280;
        }

        .info-list dd {
          margin: 0;
          color: #1f2937;
          font-weight: 500;
        }

        .crypto-amount {
          font-size: 0.875rem;
          color: #9ca3af;
          margin-left: 4px;
        }

        .prize-bar-container {
          margin: 16px 0;
          padding: 12px;
          background: #f9fafb;
          border-radius: 6px;
        }

        .prize-bar {
          display: flex;
          height: 40px;
          border-radius: 4px;
          overflow: hidden;
          border: 1px solid #d1d5db;
          background: white;
        }

        .prize-segment {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          font-weight: 600;
          color: white;
          position: relative;
        }

        .prize-segment.first {
          background: #059669;
        }

        .prize-segment.second {
          background: #3b82f6;
        }

        .prize-segment.third {
          background: #f59e0b;
        }

        .prize-segment.fee {
          background: #ef4444;
        }

        .segment-label {
          z-index: 1;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }

        .prize-table {
          width: 100%;
          border-collapse: collapse;
          margin: 16px 0;
          font-size: 0.9rem;
        }

        .prize-table th {
          background: #f3f4f6;
          padding: 10px;
          text-align: left;
          font-weight: 600;
          color: #374151;
          border-bottom: 2px solid #d1d5db;
        }

        .prize-table td {
          padding: 10px;
          border-bottom: 1px solid #e5e7eb;
          color: #1f2937;
        }

        .prize-table tr:last-child td {
          border-bottom: none;
        }

        .fee-row {
          background: #fef2f2;
          font-weight: 600;
        }

        .rules-list {
          margin: 0;
          padding-left: 24px;
          color: #374151;
        }

        .rules-list li {
          margin-bottom: 8px;
          line-height: 1.5;
        }

        .callout {
          padding: 12px;
          border-radius: 6px;
          border-left: 4px solid;
          font-size: 0.9rem;
          line-height: 1.5;
        }

        .callout-info {
          background: #eff6ff;
          border-color: #3b82f6;
          color: #1e40af;
        }

        .note {
          margin: 12px 0 0 0;
          font-size: 0.85rem;
          color: #6b7280;
          line-height: 1.4;
        }

        .placeholder {
          color: #9ca3af;
          font-style: italic;
          margin: 0;
        }

        .btn {
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          font-weight: 500;
          cursor: pointer;
          font-size: 0.9rem;
          transition: background 0.2s;
        }

        .btn-primary {
          background: #3b82f6;
          color: white;
        }

        .btn-primary:hover {
          background: #2563eb;
        }

        @media (prefers-reduced-motion: reduce) {
          .modal-open {
            animation: none;
          }
        }

        @media (max-width: 640px) {
          .modal-content {
            width: 95%;
            max-height: 95vh;
          }

          .info-list > div {
            grid-template-columns: 100px 1fr;
          }

          .prize-table {
            font-size: 0.8rem;
          }

          .prize-table th,
          .prize-table td {
            padding: 6px;
          }
        }
      `}</style>
    </dialog>
  );
};

export default LeagueRulesModal;
