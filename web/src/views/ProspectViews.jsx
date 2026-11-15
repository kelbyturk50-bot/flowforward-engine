import { prospectViewCopy } from './prospect-views.js';

// Main count is the prospect number. Team and scanner views stay secondary
// and muted. Render nothing when the flag is off (the keys are absent).
export default function ProspectViews({ proposal }) {
  const copy = prospectViewCopy(proposal);
  if (!copy) return null;
  return (
    <span className="prospect-views">
      <span className="prospect-views-main">
        {copy.main}
        {copy.last ? <span className="prospect-views-last">{`, ${copy.last}`}</span> : null}
      </span>
      {copy.since ? <span className="prospect-views-since">{copy.since}</span> : null}
      {copy.secondary ? <span className="prospect-views-team">{copy.secondary}</span> : null}
    </span>
  );
}
