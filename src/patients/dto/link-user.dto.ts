import { IsUUID } from 'class-validator';

export class LinkUserDto {
  @IsUUID()
  userId: string;
}
