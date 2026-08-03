import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { handleDatabaseError } from './database-error.handler';

interface PostgresLikeError {
  code?: string;
  driverError?: { code?: string };
}

describe('handleDatabaseError (design AD10 / section 11 — PG code mapping)', () => {
  it('maps unique violation 23505 to 409 Conflict', () => {
    const error: PostgresLikeError = { driverError: { code: '23505' } };
    expect(() => handleDatabaseError(error)).toThrow(ConflictException);
    expect(() => handleDatabaseError(error)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('maps foreign key violation 23503 to 404 Not Found', () => {
    const error: PostgresLikeError = { driverError: { code: '23503' } };
    expect(() => handleDatabaseError(error)).toThrow(NotFoundException);
    expect(() => handleDatabaseError(error)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('maps check violation 23514 to 400 Bad Request', () => {
    const error: PostgresLikeError = { driverError: { code: '23514' } };
    expect(() => handleDatabaseError(error)).toThrow(BadRequestException);
    expect(() => handleDatabaseError(error)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('maps invalid text representation 22P02 to 400 Bad Request', () => {
    const error: PostgresLikeError = { driverError: { code: '22P02' } };
    expect(() => handleDatabaseError(error)).toThrow(BadRequestException);
    expect(() => handleDatabaseError(error)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('maps unknown pg codes and plain errors to 500 Internal Server Error', () => {
    const unknownCode: PostgresLikeError = { driverError: { code: '99999' } };
    expect(() => handleDatabaseError(unknownCode)).toThrow(
      InternalServerErrorException,
    );
    expect(() => handleDatabaseError(new Error('connection lost'))).toThrow(
      InternalServerErrorException,
    );
    expect(() => handleDatabaseError(undefined)).toThrow(
      InternalServerErrorException,
    );
  });

  it('also reads the pg code directly off the root error object', () => {
    const rawPgError: PostgresLikeError = { code: '23505' };
    expect(() => handleDatabaseError(rawPgError)).toThrow(ConflictException);
  });
});
