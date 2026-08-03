import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserRole } from '../../common/enums';
import { ensureTestDbReady } from '../../test-utils/setup-test-db';
import { buildTestingApp } from '../../test-utils/test-app';
import { User } from './user.entity';

jest.setTimeout(60000);

// Unique per-run suffix: the spec never truncates the shared test database,
// so fixed emails would collide with leftovers from a previous run. The pid
// keeps two spec files that start in the same millisecond from colliding.
const EMAIL_SUFFIX = `${process.pid}-${Date.now()}`;

describe('User entity (single-role model, design section 5.2)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists a single role enum value and the is_active column', async () => {
    const user = await dataSource.getRepository(User).save({
      email: `entity.roundtrip.${EMAIL_SUFFIX}@example.com`,
      name: 'Entity Roundtrip',
      password: 'hashed-password',
      role: UserRole.DOCTOR,
      isActive: false,
    });

    expect(user.role).toBe(UserRole.DOCTOR);
    expect(user.isActive).toBe(false);

    const rows: { role: string; is_active: boolean }[] = await dataSource.query(
      'SELECT role, is_active FROM users WHERE email = $1',
      [`entity.roundtrip.${EMAIL_SUFFIX}@example.com`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('doctor');
    expect(rows[0].is_active).toBe(false);
  });

  it('loads a user with the enum role and active flag, without legacy fields', async () => {
    const created = await dataSource.getRepository(User).save({
      email: `entity.load.${EMAIL_SUFFIX}@example.com`,
      name: 'Entity Load',
      password: 'hashed-password',
      role: UserRole.ADMIN,
      isActive: true,
    });

    const loaded = await dataSource.getRepository(User).findOneBy({
      id: created.id,
    });

    expect(loaded?.role).toBe(UserRole.ADMIN);
    expect(loaded?.isActive).toBe(true);
    expect('lastName' in (loaded as object)).toBe(false);
    expect('roles' in (loaded as object)).toBe(false);
  });
});
