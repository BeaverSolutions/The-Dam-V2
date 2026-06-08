import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  PAUSE_REASON,
  getAutonomyState,
  isScheduledAutonomyPaused,
} = require('../../services/autonomyState.js');

describe('autonomy state', () => {
  it('defaults to paused scheduled autonomy', () => {
    const state = getAutonomyState({});

    expect(state.mode).toBe('paused');
    expect(state.scheduled_paused).toBe(true);
    expect(state.manual_actions_allowed).toBe(true);
    expect(state.scheduled_actions_allowed).toBe(false);
    expect(state.spend_allowed).toBe(false);
    expect(state.send_allowed).toBe(false);
    expect(state.reason).toBe(PAUSE_REASON);
    expect(state.rearm_requires).toContain('MJ approval');
    expect(state.rearm_requires).toContain('spend cap');
  });

  it('enters production_active only when unpaused and spend-capable workers are armed', () => {
    const state = getAutonomyState({
      SCHEDULED_AUTONOMY_PAUSED: 'false',
      AUTONOMOUS_ENABLED_CLIENTS: 'beaver-solutions',
      CAPTAIN_DAILY_KICKOFF_ENABLED: 'true',
    });

    expect(state.mode).toBe('production_active');
    expect(state.scheduled_paused).toBe(false);
    expect(state.scheduled_actions_allowed).toBe(true);
    expect(state.spend_allowed).toBe(true);
    expect(state.send_allowed).toBe(true);
    expect(state.scheduled_spend_workers.daily_kickoff).toBe(true);
  });

  it('can be armed without scheduled spend workers', () => {
    const state = getAutonomyState({
      SCHEDULED_AUTONOMY_PAUSED: 'false',
      AUTONOMOUS_ENABLED_CLIENTS: 'beaver-solutions',
    });

    expect(state.mode).toBe('armed');
    expect(state.scheduled_paused).toBe(false);
    expect(state.spend_allowed).toBe(false);
    expect(state.send_allowed).toBe(false);
  });

  it('supports dry-run mode as a non-spending scheduled state', () => {
    const state = getAutonomyState({
      SCHEDULED_AUTONOMY_PAUSED: 'false',
      AUTONOMY_DRY_RUN: 'true',
      AUTONOMOUS_ENABLED_CLIENTS: 'beaver-solutions',
      CAPTAIN_DAILY_KICKOFF_ENABLED: 'true',
    });

    expect(state.mode).toBe('dry_run');
    expect(state.scheduled_actions_allowed).toBe(false);
    expect(state.spend_allowed).toBe(false);
    expect(state.send_allowed).toBe(false);
  });

  it('exposes the pause predicate for scheduled workers', () => {
    expect(isScheduledAutonomyPaused({})).toBe(true);
    expect(isScheduledAutonomyPaused({ SCHEDULED_AUTONOMY_PAUSED: 'false' })).toBe(false);
  });

  it('surfaces trusted platform strategy spend state without arming scheduled autonomy', () => {
    const defaultState = getAutonomyState({});
    expect(defaultState.trusted_daily_spend_enabled).toBe(false);
    expect(defaultState.trusted_platform_strategy_required).toBe(true);
    expect(defaultState.trusted_platform_min_yield_pct).toBe(30);

    const enabledState = getAutonomyState({
      CAPTAIN_TRUSTED_DAILY_SPEND_ENABLED: 'true',
    });
    expect(enabledState.trusted_daily_spend_enabled).toBe(true);
    expect(enabledState.scheduled_actions_allowed).toBe(false);
    expect(enabledState.spend_allowed).toBe(false);
  });
});
