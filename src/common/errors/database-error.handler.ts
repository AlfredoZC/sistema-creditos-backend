import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
const POSTGRES_CHECK_VIOLATION = '23514';
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

interface ErrorCrate {
  code?: string;
  driverError?: ErrorCrate;
}

function extractPostgresErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const crate = error as ErrorCrate;
  const nestedCode = crate.driverError?.code;
  if (typeof nestedCode === 'string') {
    return nestedCode;
  }
  return typeof crate.code === 'string' ? crate.code : null;
}

/**
 * Maps TypeORM/Postgres driver errors to HTTP exceptions (design AD10):
 * 23505 -> 409 Conflict, 23503 -> 404 Not Found, 23514 and 22P02 -> 400
 * Bad Request, anything else -> 500 Internal Server Error. Always throws;
 * callers use it in catch blocks (replaces per-service handleDBErrors).
 */
export function handleDatabaseError(error: unknown): never {
  const code = extractPostgresErrorCode(error);
  switch (code) {
    case POSTGRES_UNIQUE_VIOLATION:
      throw new ConflictException('Unique constraint violation — the resource already exists');
    case POSTGRES_FOREIGN_KEY_VIOLATION:
      throw new NotFoundException('Referenced record does not exist');
    case POSTGRES_CHECK_VIOLATION:
      throw new BadRequestException('Value violates a database check constraint');
    case POSTGRES_INVALID_TEXT_REPRESENTATION:
      throw new BadRequestException('Invalid value format for the database column');
    default:
      throw new InternalServerErrorException('Unexpected database error');
  }
}
