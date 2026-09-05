export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `model budget exceeded: spent ${spentUsd.toFixed(6)} USD of ${capUsd} USD cap`,
    );
    this.name = "BudgetExceededError";
  }
}
