import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

@ValidatorConstraint({ name: 'IsMoney', async: false })
export class IsMoneyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && MONEY_PATTERN.test(value);
  }

  defaultMessage(_validationArguments?: ValidationArguments): string {
    return 'money must be a non-negative decimal with at most 2 decimal places';
  }
}

export function IsMoney(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsMoneyConstraint,
    });
  };
}
