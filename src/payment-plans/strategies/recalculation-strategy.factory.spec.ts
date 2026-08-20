import { AmortizationMode } from '../../common/enums';
import { RecalculationStrategyFactory } from './recalculation-strategy.factory';

const factory = new RecalculationStrategyFactory();

describe('RecalculationStrategyFactory (design section 7 — registry with reduce-installment fallback)', () => {
  it('returns the reduce-installment strategy for reduce_installment mode', () => {
    expect(factory.getFor(AmortizationMode.REDUCE_INSTALLMENT).mode).toBe(
      AmortizationMode.REDUCE_INSTALLMENT,
    );
  });

  it('returns the reduce-term strategy for reduce_term mode', () => {
    expect(factory.getFor(AmortizationMode.REDUCE_TERM).mode).toBe(
      AmortizationMode.REDUCE_TERM,
    );
  });

  it('falls back to the reduce-installment strategy for null and undefined modes', () => {
    expect(factory.getFor(null).mode).toBe(AmortizationMode.REDUCE_INSTALLMENT);
    expect(factory.getFor(undefined).mode).toBe(
      AmortizationMode.REDUCE_INSTALLMENT,
    );
  });

  it('returns a stable strategy instance per mode', () => {
    expect(factory.getFor(AmortizationMode.REDUCE_INSTALLMENT)).toBe(
      factory.getFor(AmortizationMode.REDUCE_INSTALLMENT),
    );
    expect(factory.getFor(AmortizationMode.REDUCE_TERM)).toBe(
      factory.getFor(AmortizationMode.REDUCE_TERM),
    );
    expect(factory.getFor(AmortizationMode.REDUCE_INSTALLMENT)).not.toBe(
      factory.getFor(AmortizationMode.REDUCE_TERM),
    );
  });
});
