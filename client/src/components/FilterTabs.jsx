import React from 'react';

export default function FilterTabs({ tabs, active, onChange }) {
  return (
    <div className="filter-tabs">
      {tabs.map(tab => (
        <button
          key={tab.value}
          className={`filter-tab ${active === tab.value ? 'filter-tab--active' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="filter-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
