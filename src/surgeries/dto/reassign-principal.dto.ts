import { IsUUID } from 'class-validator';

export class ReassignPrincipalDto {
  @IsUUID()
  doctorId: string;
}
