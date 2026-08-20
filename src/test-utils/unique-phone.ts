/**
 * Telefonos unicos para specs de integracion.
 *
 * `patients.phone` es UNIQUE y la base de test se comparte entre todas las
 * suites. Cada spec tenia su propia version de este generador con un contador
 * PROPIO; con `--runInBand` todos los archivos corren en el mismo proceso, asi
 * que dos suites distintas producian el mismo numero cuando sus contadores
 * coincidian dentro de la misma ventana de milisegundos, y la insercion moria
 * con "duplicate key uq_patients_phone".
 *
 * La secuencia vive en `globalThis`, o sea que es unica para todo el proceso de
 * jest y no depende de que cada archivo lleve su propia cuenta.
 */
const GLOBAL_SEQUENCE_KEY = '__creditosUniquePhoneSequence';

function nextSequence(): number {
  const store = globalThis as Record<string, unknown>;
  const next = ((store[GLOBAL_SEQUENCE_KEY] as number) ?? 0) + 1;
  store[GLOBAL_SEQUENCE_KEY] = next;
  return next;
}

/**
 * Movil nacional de 8 digitos que empieza con 7: es el formato que ejercita la
 * heuristica +591 del normalizador de telefonos.
 */
export function uniqueMobile8(): string {
  const timePart = String(Date.now()).slice(-4);
  const sequencePart = String(nextSequence() % 1000).padStart(3, '0');
  return `7${timePart}${sequencePart}`;
}

/** Version en formato internacional, para specs que insertan ya normalizado. */
export function uniqueInternationalPhone(): string {
  return `+591${uniqueMobile8()}`;
}
