import { FitBadge, StageChip, Stars, relDate, isOverdue, telHref } from '../ui';

/** A compact, tappable lead line used on Today and in lists. */
export default function LeadRow({ lead, onOpen, actions, showStage = true, showNext = false }) {
  return (
    <li className="lead-row">
      <button className="lead-hit" onClick={() => onOpen(lead.id)} aria-label={`Open ${lead.company}`}>
        <FitBadge score={lead.fit_score} tier={lead.fit_tier} />
        <span className="lead-main">
          <span className="lead-name">{lead.company}</span>
          <span className="lead-sub">
            {lead.industry}{lead.city ? `, ${lead.city}` : ''}
            <span className="sep" aria-hidden="true" />
            <Stars rating={lead.rating} reviews={lead.review_count} />
          </span>
          {showNext && lead.next_action_at && (
            <span className={`lead-next ${isOverdue(lead.next_action_at) ? 'overdue' : ''}`}>
              {lead.next_action || 'Follow up'}, {relDate(lead.next_action_at)}
            </span>
          )}
        </span>
        {showStage && <StageChip stage={lead.stage} />}
      </button>
      <span className="lead-actions">
        {lead.phone && <a className="btn btn-quiet btn-sm" href={telHref(lead.phone)} aria-label={`Call ${lead.company}`}>Call</a>}
        {actions}
      </span>
    </li>
  );
}
