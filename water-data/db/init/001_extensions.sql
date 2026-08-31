-- AquaRoute E3.1: required PostgreSQL extensions for local water data.
-- Only PostGIS for now — spatial types/functions for future water geometry.
-- No extra extensions (topology, raster, etc.) until a stage needs them.

CREATE EXTENSION IF NOT EXISTS postgis;
