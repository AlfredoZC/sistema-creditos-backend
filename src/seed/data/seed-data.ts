import * as bcrypt from 'bcrypt';

interface SeedUser {
  email: string;
  name: string;
  lastName: string;
  password: string;
  roles: string[];
}

interface SeedData {
  users: SeedUser[];
}

export const initialData: SeedData = {
  users: [],
};

// Añade estos nombres y apellidos al principio del archivo
const names = [
  'Ana',
  'Carlos',
  'Daniel',
  'Elena',
  'Fernando',
  'Gloria',
  'Hector',
  'Isabel',
  'Jorge',
  'Laura',
];
const lastNames = [
  'Garcia',
  'Martinez',
  'Rodriguez',
  'Lopez',
  'Sanchez',
  'Perez',
  'Gonzalez',
  'Hernandez',
  'Diaz',
  'Torres',
];

// Añade esta función para generar un email aleatorio
function randomEmail(name: string, lastName: string, i: number) {
  const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
  const randomDomain = domains[Math.floor(Math.random() * domains.length)];
  return `${name.toLowerCase()}.${lastName.toLowerCase()}${i}@${randomDomain}`;
}

// Añade esta función para generar un rol aleatorio
function randomRole() {
  const roles = ['admin', 'super-user', 'user'];
  const randomIndex = Math.floor(Math.random() * roles.length);
  return roles[randomIndex];
}

// Añade este bucle for para generar 20 usuarios de prueba y añadirlos al array initialData.users
for (let i = 0; i < 20; i++) {
  // Elige un nombre y un apellido al azar
  const randomName = names[Math.floor(Math.random() * names.length)];
  const randomLastName =
    lastNames[Math.floor(Math.random() * lastNames.length)];
  // Genera un email, una contraseña y un rol aleatorios
  const email = randomEmail(randomName, randomLastName, i);
  const password = bcrypt.hashSync('Abc123', 10);
  const role = randomRole();
  // Crea un objeto de tipo SeedUser con los datos generados
  const user: SeedUser = {
    email,
    name: randomName,
    lastName: randomLastName,
    password,
    roles: [role],
  };
  if (role !== 'user') user.roles.push('user');
  // Añade el usuario al array initialData.users
  initialData.users.push(user);
}
