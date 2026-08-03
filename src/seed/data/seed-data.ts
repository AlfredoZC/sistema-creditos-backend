import * as bcrypt from 'bcrypt';
import { UserRole } from '../../common/enums';

interface SeedUser {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

interface SeedData {
  users: SeedUser[];
}

const SEED_PASSWORD = 'Abc123';

// Deterministic plan: exactly one admin, then a balanced office/doctor/patient
// mix so the seeded database exercises every role the API can authenticate.
const USER_SEED_PLAN: Array<{ name: string; role: UserRole }> = [
  { name: 'Admin', role: UserRole.ADMIN },
  { name: 'Ana', role: UserRole.OFFICE },
  { name: 'Carlos', role: UserRole.OFFICE },
  { name: 'Daniel', role: UserRole.OFFICE },
  { name: 'Elena', role: UserRole.DOCTOR },
  { name: 'Fernando', role: UserRole.DOCTOR },
  { name: 'Gloria', role: UserRole.DOCTOR },
  { name: 'Hector', role: UserRole.PATIENT },
  { name: 'Isabel', role: UserRole.PATIENT },
  { name: 'Jorge', role: UserRole.PATIENT },
];

export const initialData: SeedData = {
  users: USER_SEED_PLAN.map((entry, index) => ({
    email: `${entry.name.toLowerCase()}${index}@seed.local`,
    name: entry.name,
    password: bcrypt.hashSync(SEED_PASSWORD, 10),
    role: entry.role,
  })),
};
