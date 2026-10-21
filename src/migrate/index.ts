/** Legacy Boostnote (CSON storage) → vault importer. Pure Node; used by the CLI and the app (phase 4). */
export { type FindLegacyStoragesOptions, findLegacyStorages, type LegacyStorageLocation } from './find.ts'
export { MigrationError } from './legacy.ts'
export { type MigratedNote, type MigrateOptions, type MigrationReport, migrateStorage } from './migrate.ts'
