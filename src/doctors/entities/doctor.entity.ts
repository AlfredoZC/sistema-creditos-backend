import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../auth/entities/user.entity';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('doctors')
export class Doctor {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'user_id', unique: true })
  userId: string;

  @ApiProperty()
  @Column('text')
  specialty: string;

  @ApiProperty()
  @Column('text', { name: 'professional_license', unique: true })
  professionalLicense: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
