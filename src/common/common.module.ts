import { Module } from '@nestjs/common';

export * from './enums';
export * from './errors';
export * from './transformers';
export * from './validators';

/**
 * Shared infrastructure namespace: domain enums, the decimal money
 * transformer, the IsMoney validator and the database error handler.
 * Re-exports keep feature modules consuming common utilities without
 * circular module imports (design section 3).
 */
@Module({})
export class CommonModule {}
