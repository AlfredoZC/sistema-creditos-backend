import { IsOptional, IsString } from 'class-validator';

export class CreateProfileDto {
  @IsString()
  @IsOptional()
  gender?: string;

  @IsString()
  photo: string;
}
