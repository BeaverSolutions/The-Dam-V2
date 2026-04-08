-- Migration 026: Fix missing schema_migrations inserts
-- Several earlier migrations did not register themselves in the tracking table.

INSERT INTO schema_migrations (version) VALUES (3)  ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (6)  ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (10) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (11) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (12) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (13) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (14) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (16) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (20) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (21) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (22) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES (26) ON CONFLICT (version) DO NOTHING;
