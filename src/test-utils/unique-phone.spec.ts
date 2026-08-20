import { uniqueInternationalPhone, uniqueMobile8 } from './unique-phone';

describe('uniqueMobile8', () => {
  it('produces an 8-digit national mobile starting with 7', () => {
    expect(uniqueMobile8()).toMatch(/^7\d{7}$/);
  });

  // El fallo real que motivo este helper: dos suites distintas generando el
  // mismo numero dentro del mismo proceso de jest.
  it('never repeats a value within the process', () => {
    const generated = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      generated.add(uniqueMobile8());
    }
    expect(generated.size).toBe(1000);
  });

  it('produces the international form with the +591 prefix', () => {
    expect(uniqueInternationalPhone()).toMatch(/^\+5917\d{7}$/);
  });
});
