import React, { useState } from 'react';

const BEAVER_IMAGES = {
  research_beaver: '/assets/beavers/research-beaver.png',
  sales_beaver: '/assets/beavers/sales-beaver.png',
  ranger: '/assets/beavers/ranger-beaver.png',
  director: '/assets/beavers/director-beaver.png',
};

const BEAVER_COLORS = {
  research_beaver: 'var(--orange)',
  sales_beaver: 'var(--lime)',
  ranger: 'var(--police-blue)',
  director: 'var(--purple)',
};

const BEAVER_LABELS = {
  research_beaver: 'Research Beaver',
  sales_beaver: 'Sales Beaver',
  ranger: 'Ranger Beaver',
  director: 'The Director',
};

const BEAVER_INITIALS = {
  research_beaver: 'R',
  sales_beaver: 'S',
  ranger: 'R',
  director: 'D',
};

const SIZE_MAP = {
  xs: { width: 24, height: 36 },
  sm: { width: 40, height: 60 },
  md: { width: 64, height: 96 },
  lg: { width: 120, height: 180 },
  xl: { width: 200, height: 300 },
};

export default function BeaverAvatar({ agent, size = 'md', animate = false, state = 'idle', className = '' }) {
  const [imgError, setImgError] = useState(false);
  const dims = SIZE_MAP[size] || SIZE_MAP.md;
  const src = BEAVER_IMAGES[agent];
  const color = BEAVER_COLORS[agent] || 'var(--text-muted)';
  const label = BEAVER_LABELS[agent] || 'Beaver';
  const initial = BEAVER_INITIALS[agent] || '?';

  const stateClass = state !== 'idle' ? `beaver-state--${state}` : '';
  const animClass = animate ? `beaver-animated${state !== 'idle' ? ` ${state}` : ''}` : '';

  if (!src || imgError) {
    return (
      <div
        className={`beaver-avatar-fallback ${className}`}
        style={{
          width: dims.width, height: dims.width, borderRadius: '50%',
          background: color, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontWeight: 700, fontSize: dims.width * 0.4,
          color: 'var(--bg)', flexShrink: 0,
        }}
        title={label}
      >{initial}</div>
    );
  }

  return (
    <img
      src={src}
      alt={label}
      className={`beaver-img ${animClass} ${stateClass} ${className}`.trim().replace(/\s+/g, ' ')}
      style={{ width: dims.width, height: dims.height, objectFit: 'contain', flexShrink: 0 }}
      loading="lazy"
      onError={() => setImgError(true)}
    />
  );
}

export { BEAVER_IMAGES, BEAVER_COLORS, BEAVER_LABELS };
