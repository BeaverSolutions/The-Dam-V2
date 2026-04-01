import React from 'react';
import BeaverAvatar from './BeaverAvatar';

export default function EmptyState({ agent, title, description, actionLabel, onAction }) {
  return (
    <div className="empty-state">
      <BeaverAvatar agent={agent} size="lg" animate state="idle" />
      <h3>{title}</h3>
      <p>{description}</p>
      {actionLabel && onAction && (
        <button className="btn btn-primary" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
