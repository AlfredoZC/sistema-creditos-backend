import { AmortizationMode } from '../../common/enums';
import { InstallmentRecalculationStrategy } from './installment-recalculation.strategy';
import { ReduceInstallmentRecalculationStrategy } from './reduce-installment.recalculation-strategy';
import { ReduceTermRecalculationStrategy } from './reduce-term.recalculation-strategy';

/**
 * Registry of amortization recalculation strategies (design section 7). Unknown,
 * null or undefined modes fall back to the default reduce-installment strategy.
 */
export class RecalculationStrategyFactory {
  private readonly reduceInstallment =
    new ReduceInstallmentRecalculationStrategy();

  private readonly strategies: ReadonlyMap<
    AmortizationMode,
    InstallmentRecalculationStrategy
  > = new Map<AmortizationMode, InstallmentRecalculationStrategy>([
    [AmortizationMode.REDUCE_INSTALLMENT, this.reduceInstallment],
    [AmortizationMode.REDUCE_TERM, new ReduceTermRecalculationStrategy()],
  ]);

  getFor(
    mode: AmortizationMode | null | undefined,
  ): InstallmentRecalculationStrategy {
    if (mode === null || mode === undefined) {
      return this.reduceInstallment;
    }
    return this.strategies.get(mode) ?? this.reduceInstallment;
  }
}
