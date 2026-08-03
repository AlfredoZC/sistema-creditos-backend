import {
  IsEmail,
  IsEnum,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../common/enums';

export class CreateStaffUserDto {
  @IsString()
  @MaxLength(50)
  name: string;

  @IsString()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(50)
  @Matches(/(?:(?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'The password must have a Uppercase, lowercase letter and a number',
  })
  password: string;

  @IsEnum(UserRole)
  @IsIn([UserRole.OFFICE, UserRole.ADMIN])
  role: UserRole;
}
